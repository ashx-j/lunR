import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrWatchExtension } from "../src/builtin-extensions/lunr-pr-watch.ts";
import type { PrObservation, PullRequestIdentity } from "../src/core/pr-watch/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

const url = "https://github.com/o/r/pull/1";
function observation(): PrObservation {
	return {
		snapshot: {
			head: "a".repeat(40),
			state: "open",
			title: "Test",
			headRef: "feature",
			commitMessage: "Test",
			commitDate: "2026-10-06T10:00:00Z",
			checks: [],
			checksComplete: true,
			evidence: [],
		},
		faults: [],
	};
}
const releases: (() => void)[] = [];
function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { resolve, promise };
}
const fixtures: { harness: Harness; dir: string }[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const release of releases.splice(0)) release();
	for (const { harness, dir } of fixtures.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await harness.session.shutdown();
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
	vi.useRealTimers();
});

async function setup(options: { read?: (signal: AbortSignal) => Promise<PrObservation>; tools?: AgentTool[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "lunr-pr-session-"));
	const read = vi.fn(async (_pr: PullRequestIdentity, signal: AbortSignal) =>
		options.read ? options.read(signal) : observation(),
	);
	const harness = await createHarness({
		tools: options.tools,
		initialActiveToolNames: ["pr_watch", ...(options.tools?.map((tool) => tool.name) ?? [])],
		extensionFactories: [createPrWatchExtension({ agentDir: dir, read })],
	});
	fixtures.push({ harness, dir });
	await harness.session.bindExtensions({ mode: "print" });
	const tool = harness.session.getToolDefinition("pr_watch");
	if (!tool) throw new Error("PR watcher tool missing");
	const ctx = harness.session.extensionRunner.createContext();
	return { harness, read, tool, ctx };
}

describe("PR watch owning session admission", () => {
	it("wakes the idle owner once, persists the notification, and makes no model calls on quiet polls", async () => {
		vi.useFakeTimers();
		const f = await setup();
		f.harness.setResponses([fauxAssistantMessage("Observed feedback")]);
		const started = await f.tool.execute("start", { action: "start", url }, undefined, undefined, f.ctx);
		expect(started.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Deadline") });
		await vi.advanceTimersByTimeAsync(0);
		await f.harness.session.waitForIdle();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.harness.faux.state.callCount).toBe(1);
		expect(
			f.harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pr_watch_update"),
		).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.harness.faux.state.callCount).toBe(1);
	});

	it("delivers feedback after the busy turn through followUp without aborting its tool", async () => {
		vi.useFakeTimers();
		const gate = deferred();
		const toolStarted = deferred();
		let siblingSignal: AbortSignal | undefined;
		const sibling: AgentTool = {
			name: "sibling",
			label: "Sibling",
			description: "Hold this turn",
			parameters: Type.Object({}),
			execute: async (_id, _params, signal) => {
				siblingSignal = signal;
				toolStarted.resolve();
				await gate.promise;
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
		};
		const f = await setup({ tools: [sibling] });
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("sibling", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Original work finished"),
			fauxAssistantMessage("Feedback received"),
		]);
		const turn = f.harness.session.prompt("work");
		await toolStarted.promise;
		await f.tool.execute("start", { action: "start", url }, undefined, undefined, f.ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.harness.faux.state.callCount).toBe(1);
		expect(siblingSignal?.aborted).toBe(false);
		gate.resolve();
		await turn;
		await vi.advanceTimersByTimeAsync(1);
		expect(f.harness.faux.state.callCount).toBe(3);
		const texts = f.harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => message.content);
		expect(texts.at(-1)).toContainEqual(expect.objectContaining({ text: "Feedback received" }));
		expect(
			f.harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pr_watch_update"),
		).toHaveLength(1);
	});

	it("new user input interrupts a real pr_watch wait through normal prompt admission and leaves the watch/read active", async () => {
		const readStarted = deferred();
		const releaseRead = deferred();
		let readSignal: AbortSignal | undefined;
		const f = await setup({
			read: async (signal) => {
				readSignal = signal;
				readStarted.resolve();
				await releaseRead.promise;
				return observation();
			},
		});
		f.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("pr_watch", { action: "start", url, wait: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fresh input handled"),
			fauxAssistantMessage("Feedback received"),
		]);
		const first = f.harness.session.prompt("watch this PR");
		await readStarted.promise;
		const editor = {
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
			addToHistory: vi.fn(),
			setText: vi.fn(),
		};
		const interactive = {
			defaultEditor: editor,
			editor,
			runtimeHost: { isDetached: false, services: { agentDir: "" } },
			transferInProgress: false,
			sessionManager: f.harness.sessionManager,
			session: f.harness.session,
			ui: { setChatScroll: vi.fn(), requestRender: vi.fn() },
			consumeStagedSubmitImages: () => undefined,
			takeSubmittedImages: () => [],
			loadImageAttachments: async () => undefined,
			isExtensionCommand: () => false,
			awaitDeferredBuiltinsForPrompt: async () => {},
			promptAfterDeferredBuiltins: vi.fn(async () => {}),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};
		const prototype = InteractiveMode.prototype as unknown as {
			setupEditorSubmitHandler(this: typeof interactive): void;
		};
		prototype.setupEditorSubmitHandler.call(interactive);
		const handoffCall = vi.spyOn(f.harness.session, "interruptSubagentWaitWithPrompt");
		await editor.onSubmit?.("new user input");
		const handoff = await handoffCall.mock.results[0]?.value;
		expect(handoff).toBeDefined();
		await Promise.all([first, handoff?.completion]);
		expect(interactive.promptAfterDeferredBuiltins).not.toHaveBeenCalled();
		expect(interactive.showError).not.toHaveBeenCalled();
		expect(editor.setText).toHaveBeenCalledWith("");
		expect(getUserTexts(f.harness)).toEqual(["watch this PR", "new user input"]);
		expect(f.harness.session.getSteeringMessages()).toEqual([]);
		expect(readSignal?.aborted).toBe(false);
		const result = f.harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "pr_watch",
		);
		expect(result?.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining("Wait interrupted") }),
		);
		releaseRead.resolve();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await f.harness.session.waitForIdle();
		expect(
			f.harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "pr_watch_update"),
		).toBe(true);
	});

	it("shutdown releases a waiting tool and ignores a late read without waking another session", async () => {
		const readStarted = deferred();
		const releaseRead = deferred();
		let readSignal: AbortSignal | undefined;
		const f = await setup({
			read: async (signal) => {
				readSignal = signal;
				readStarted.resolve();
				await releaseRead.promise;
				return observation();
			},
		});
		const wait = f.tool.execute("start", { action: "start", url, wait: true }, undefined, undefined, f.ctx);
		await readStarted.promise;
		await f.harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "resume" });
		const other = await setup();
		expect(readSignal?.aborted).toBe(true);
		expect((await wait).content[0]).toMatchObject({ text: expect.stringContaining("Wait interrupted") });
		releaseRead.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.harness.faux.state.callCount).toBe(0);
		expect(other.harness.faux.state.callCount).toBe(0);
		expect(other.read).not.toHaveBeenCalled();
		expect(f.harness.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
	});

	it("user slash commands cancel/restart a watch while repeated agent starts cannot", async () => {
		const f = await setup();
		const first = await f.tool.execute("start", { action: "start", url }, undefined, undefined, f.ctx);
		const details: unknown = first.details;
		if (!details || typeof details !== "object" || !("watchId" in details) || typeof details.watchId !== "string")
			throw new Error("Missing watch ID");
		const wait = f.tool.execute("wait", { action: "wait", id: details.watchId }, undefined, undefined, f.ctx);
		await f.harness.session.prompt(`/pr-watch cancel ${details.watchId}`);
		expect((await wait).content[0]).toMatchObject({ text: expect.stringContaining("cancelled") });
		const repeated = await f.tool.execute("start-again", { action: "start", url }, undefined, undefined, f.ctx);
		expect(repeated.details).toMatchObject({ state: "cancelled" });
		await f.harness.session.prompt(`/pr-watch restart ${details.watchId}`);
		const restarted = await f.tool.execute("start-after-user", { action: "start", url }, undefined, undefined, f.ctx);
		expect(restarted.details).toMatchObject({ watchId: details.watchId, state: "active" });
	});
});
