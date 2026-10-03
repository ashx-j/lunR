import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPermissionMode } from "../src/core/permissions.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function heldTool() {
	const entered = deferred();
	const released = deferred();
	const cancelled = deferred();
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Inert held tool",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			entered.resolve();
			signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
			await released.promise;
			return { content: [{ type: "text", text: "final held result" }], details: {} };
		},
	};
	return { tool, entered, released, cancelled };
}

describe("session operation ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		vi.unstubAllEnvs();
		while (harnesses.length) {
			const harness = harnesses.pop()!;
			await harness.session.shutdown();
			harness.cleanup();
		}
	});
	async function harness(options?: Parameters<typeof createHarness>[0]) {
		const result = await createHarness(options);
		harnesses.push(result);
		return result;
	}

	it("claims idle admission before deferred preflight and rejects a rival without settling the owner", async () => {
		const entered = deferred();
		const prepared = deferred();
		const held = heldTool();
		const h = await harness({
			tools: [held.tool],
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.resolve();
						await prepared.promise;
						return { action: "continue" };
					});
				},
			],
		});
		h.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
		const first = h.session.prompt("first");
		await entered.promise;
		const busyDuringPreflight = !h.session.isIdle;
		const accepted: boolean[] = [];
		const second = h.session.prompt("second", { preflightResult: (ok) => accepted.push(ok) });
		const rejected = second.then(
			() => undefined,
			(error: unknown) => error,
		);
		let idle = false;
		const waiting = h.session.waitForIdle().then(() => {
			idle = true;
		});
		prepared.resolve();
		await held.entered.promise;
		const secondError = await rejected;
		const stillBusy = !h.session.isIdle && !idle;
		const settledCount = h.eventsOfType("agent_settled").length;
		const abort = h.session.abort();
		held.released.resolve();
		await Promise.all([first, abort, waiting]);
		expect(busyDuringPreflight).toBe(true);
		expect(secondError).toBeInstanceOf(Error);
		expect(accepted).toEqual([false]);
		expect(stillBusy).toBe(true);
		expect(settledCount).toBe(0);
		expect(h.session.isIdle).toBe(true);
	});

	it("cancels preflight during close and blocks new admission until shutdown finishes", async () => {
		const entered = deferred();
		const prepared = deferred();
		const h = await harness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						entered.resolve();
						await prepared.promise;
						return { action: "continue" };
					});
				},
			],
		});
		const admitted: boolean[] = [];
		const first = h.session.prompt("first", { preflightResult: (ok) => admitted.push(ok) });
		const rejected = expect(first).rejects.toThrow(/closing|cancelled/);
		await entered.promise;
		let closed = false;
		const shutdown = h.session.shutdown().then(() => {
			closed = true;
		});
		await expect(h.session.prompt("new")).rejects.toThrow(/closing/);
		expect(closed).toBe(false);
		prepared.resolve();
		await Promise.all([rejected, shutdown]);
		expect(admitted).toEqual([false]);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
	});

	it.each([false, true])(
		"persists the late tool result across manual compaction, cancelled summary=%s",
		async (cancelSummary) => {
			const held = heldTool();
			let sawResult = false;
			const h = await harness({
				tools: [held.tool],
				settings: { compaction: { keepRecentTokens: 1, enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							const result = event.branchEntries.find(
								(entry) => entry.type === "message" && entry.message.role === "toolResult",
							);
							sawResult = !!result;
							if (cancelSummary) return { cancel: true };
							return {
								compaction: {
									summary: "inert summary",
									firstKeptEntryId: result!.id,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			h.setResponses([
				fauxAssistantMessage("seed"),
				fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			]);
			await h.session.prompt("seed");
			const first = h.session.prompt("tool turn");
			await held.entered.promise;
			const compact = h.session.compact();
			const compactResult = cancelSummary
				? expect(compact).rejects.toThrow("Compaction cancelled")
				: expect(compact).resolves.toMatchObject({ summary: "inert summary" });
			await held.cancelled.promise;
			held.released.resolve();
			await first;
			await compactResult;
			expect(sawResult).toBe(true);
			expect(h.session.messages.some((message) => message.role === "toolResult")).toBe(true);
		},
	);

	it("keeps overlapping bash cancellation owned until every operation settles", async () => {
		const h = await harness();
		const firstRelease = deferred<{ exitCode: number | null }>();
		const secondRelease = deferred<{ exitCode: number | null }>();
		const signals: AbortSignal[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				signals.push(options.signal!);
				return signals.length === 1 ? firstRelease.promise : secondRelease.promise;
			},
		};
		const first = h.session.executeBash("first", undefined, { operations });
		const second = h.session.executeBash("second", undefined, { operations });
		firstRelease.resolve({ exitCode: 0 });
		await first;
		expect(h.session.isBashRunning).toBe(true);
		h.session.abortBash();
		expect(signals[1].aborted).toBe(true);
		let stopped = false;
		const abort = h.session.abort().then(() => {
			stopped = true;
		});
		expect(stopped).toBe(false);
		secondRelease.resolve({ exitCode: 0 });
		await Promise.all([second, abort]);
		expect(h.session.isBashRunning).toBe(false);
		expect(h.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(2);
	});

	it("session abort cancels all overlapping bash operations and awaits their recorded results", async () => {
		const h = await harness();
		const releases = [deferred<{ exitCode: number | null }>(), deferred<{ exitCode: number | null }>()];
		const signals: AbortSignal[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				const index = signals.length;
				signals.push(options.signal!);
				return releases[index].promise;
			},
		};
		const calls = [
			h.session.executeBash("one", undefined, { operations }),
			h.session.executeBash("two", undefined, { operations }),
		];
		const shutdown = h.session.shutdown();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(() => h.session.sessionManager.assertWritable()).not.toThrow();
		for (const release of releases) release.resolve({ exitCode: 0 });
		await Promise.all([...calls, shutdown]);
		expect(h.session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(2);
		expect(() => h.session.sessionManager.assertWritable()).toThrow(/released/);
	});

	it("returns correlated settled prompt messages and rejects busy scheduled prompts", async () => {
		const h = await harness();
		h.setResponses([fauxAssistantMessage("first result"), fauxAssistantMessage("second result")]);
		const first = h.session.promptWithCompletion("first");
		await expect(h.session.promptWithCompletion("rival")).rejects.toThrow(/busy/);
		const result = await first;
		const next = await h.session.promptWithCompletion("second");
		expect(result.messages).toHaveLength(2);
		expect(next.messages).toHaveLength(2);
		expect(JSON.stringify(result.messages)).toContain("first result");
		expect(JSON.stringify(next.messages)).not.toContain("first result");
		expect(h.session.isIdle).toBe(true);
	});

	it("initializes isolated read-only tools and routes mode changes to the same context", async () => {
		const read = await harness({ settings: { defaultPermissionMode: "read-only" } });
		const write = await harness();
		expect(getPermissionMode(read.session.sessionId)).toBe("read-only");
		expect(write.session.permissionMode).toBe("yolo");
		expect(read.session.systemPrompt).toContain("read-only mode");
		const args = { path: "never-written.txt", content: "inert" };
		const message = fauxAssistantMessage([fauxToolCall("write", args)], { stopReason: "toolUse" });
		const toolCall = { type: "toolCall" as const, name: "write", id: "inert", arguments: args };
		await expect(
			read.session.agent.beforeToolCall!({ toolCall, args, assistantMessage: message }),
		).resolves.toMatchObject({ block: true });
		read.session.setPermissionMode("auto");
		expect(getPermissionMode(read.session.sessionId)).toBe("auto");
		expect(read.session.sessionManager.getPermissionMode()).toBe("auto");
		expect(write.session.permissionMode).toBe("yolo");
		await expect(
			read.session.agent.beforeToolCall!({ toolCall, args, assistantMessage: message }),
		).resolves.toBeUndefined();
	});
	it.each(["print", "rpc", "json"] as const)(
		"restores the saved SDK checkpoint before %s tool hooks execute",
		async (mode) => {
			const h = await harness();
			const manager = SessionManager.inMemory(h.tempDir);
			manager.setPermissionMode("read-only");
			const { session } = await createAgentSession({
				cwd: h.tempDir,
				agentDir: h.tempDir,
				model: h.getModel(),
				modelRuntime: h.session.modelRuntime,
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory({ defaultPermissionMode: "auto" }),
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await session.bindExtensions({ mode });
				const args = { path: "never-written.txt", content: "inert" };
				const toolCall = { type: "toolCall" as const, name: "write", id: "inert", arguments: args };
				const assistantMessage = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
				expect(session.permissionMode).toBe("read-only");
				await expect(session.agent.beforeToolCall!({ toolCall, args, assistantMessage })).resolves.toMatchObject({
					block: true,
				});
			} finally {
				await session.shutdown();
			}
		},
	);

	it("keeps explicit child inheritance ahead of the saved checkpoint and settings", async () => {
		vi.stubEnv("PI_SUBAGENT_CHILD", "1");
		vi.stubEnv("PI_SUBAGENT_CHILD_PERMISSION", "read-only");
		const read = await harness({ settings: { defaultPermissionMode: "yolo" } });
		expect(read.session.permissionMode).toBe("read-only");
		vi.stubEnv("PI_SUBAGENT_CHILD_PERMISSION", "full");
		const full = await harness({ settings: { defaultPermissionMode: "read-only" } });
		expect(full.session.permissionMode).toBe("auto");
		const manager = SessionManager.inMemory(full.tempDir);
		manager.setPermissionMode("read-only");
		const { session } = await createAgentSession({
			cwd: full.tempDir,
			agentDir: full.tempDir,
			model: full.getModel(),
			modelRuntime: full.session.modelRuntime,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ defaultPermissionMode: "read-only" }),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			expect(session.permissionMode).toBe("auto");
		} finally {
			await session.shutdown();
		}
	});

	it("applies an interactive mode change to the existing session permission context", async () => {
		const h = await harness();
		const mode = Object.create(InteractiveMode.prototype) as {
			runtimeHost: { session: Harness["session"]; services: { agentDir: string }; isDetached: boolean };
			ui: { requestRender: () => void };
			applyPermissionMode: (mode: "read-only", options: { silent: boolean }) => void;
		};
		mode.runtimeHost = { session: h.session, services: { agentDir: h.tempDir }, isDetached: false };
		mode.ui = { requestRender: vi.fn() };
		mode.applyPermissionMode("read-only", { silent: true });
		expect(getPermissionMode(h.session.sessionId)).toBe("read-only");
		expect(h.session.sessionManager.getPermissionMode()).toBe("read-only");
		expect(h.session.systemPrompt).toContain("read-only mode");
	});
	it("preserves an explicit SDK permission override without changing other session contexts", async () => {
		const h = await harness({ settings: { defaultPermissionMode: "read-only" } });
		const manager = SessionManager.inMemory(h.tempDir);
		manager.setPermissionMode("read-only");
		const { session } = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			model: h.getModel(),
			modelRuntime: h.session.modelRuntime,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory({ defaultPermissionMode: "read-only" }),
			resourceLoader: createTestResourceLoader(),
			permissionMode: "auto",
		});
		try {
			expect(session.permissionMode).toBe("auto");
			expect(h.session.permissionMode).toBe("read-only");
		} finally {
			await session.shutdown();
		}
	});
});
