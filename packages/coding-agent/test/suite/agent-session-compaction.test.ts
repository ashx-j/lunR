import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	estimateContextTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import type { SessionCompaction } from "../../src/core/session-compaction.ts";
import { createHarness, type Harness } from "./harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = createAssistant(harness, {
		stopReason: "stop",
		totalTokens: 100,
		timestamp: now - 500,
	});
	assistant.content = [{ type: "text", text: "assistant response to compact" }];
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<Api>;

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("saves the built-in summary as not from an extension when a handler returns { compaction: null }", async () => {
		const compactEvents: Array<{ fromExtension: boolean }> = [];
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(pi) => {
					// A JavaScript extension can return null where the types expect a compaction or nothing.
					pi.on("session_before_compact", async () => ({ compaction: null }) as never);
					pi.on("session_compact", async (event) => {
						compactEvents.push({ fromExtension: event.fromExtension });
					});
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "built-in summary");

		await harness.session.compact();
		const entries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(entries).toHaveLength(1);
		expect(entries[0]?.type === "compaction" && entries[0].fromHook).toBe(false);
		expect(compactEvents).toEqual([{ fromExtension: false }]);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;

		await sessionInternals.runAutoCompaction("threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("treats a repeated manual compaction as a no-op", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary");

		const first = await harness.session.compact();
		const eventCount = harness.eventsOfType("compaction_end").length;
		const second = await harness.session.compact();

		expect(second).toEqual(first);
		expect(getStreamCallCount()).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(eventCount);
	});

	it("compacts Codex tool output before the next provider request", async () => {
		const dumpTool: AgentTool = {
			name: "dump",
			label: "Dump",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(800) }], details: {} }),
		};
		const harness = await createHarness({
			provider: "openai-codex",
			api: "openai-codex-responses",
			models: [{ id: "codex-test", contextWindow: 5000, maxTokens: 100 }],
			tools: [dumpTool],
			settings: { compaction: { reserveTokens: 100, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "mid-turn summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({ compaction: { reserveTokens: 100, keepRecentTokens: 1 } });
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "old context ".repeat(700) }],
			timestamp: Date.now() - 400,
		});
		harness.sessionManager.appendMessage(createAssistant(harness, { timestamp: Date.now() - 300 }));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let requestCount = 0;
		let secondRequestSawCompaction = false;
		harness.session.agent.streamFn = (_model, context) => {
			requestCount++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistant(harness, {
					stopReason: requestCount === 1 ? "toolUse" : "stop",
					totalTokens: requestCount === 1 ? 4800 : 100,
				});
				message.content = requestCount === 1 ? [fauxToolCall("dump", {})] : [{ type: "text", text: "done" }];
				if (requestCount === 2) {
					secondRequestSawCompaction = JSON.stringify(context.messages).includes("mid-turn summary");
				}
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		};

		await harness.session.prompt("start");

		expect(secondRequestSawCompaction).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: true,
		});
	});

	// One run of tool turns whose reported usage is `usage[i]` per request. Returns, per request, whether it
	// already carried the compaction summary.
	async function runToolTurns(harness: Harness, usage: number[]): Promise<boolean[]> {
		const sawSummary: boolean[] = [];
		harness.session.agent.streamFn = (_model, context) => {
			const index = sawSummary.length;
			sawSummary.push(JSON.stringify(context.messages).includes("ceiling summary"));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const last = index === usage.length - 1;
				const message = createAssistant(harness, {
					stopReason: last ? "stop" : "toolUse",
					totalTokens: usage[index],
				});
				message.content = last ? [{ type: "text", text: "done" }] : [fauxToolCall("dump", {})];
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		};
		await harness.session.prompt("start");
		return sawSummary;
	}

	async function createCeilingHarness(
		toolDescription: string,
		options: { cancelCompaction?: boolean; seed?: boolean } = {},
	): Promise<Harness & { compactionAttempts: () => number }> {
		let attempts = 0;
		const dumpTool: AgentTool = {
			name: "dump",
			label: "Dump",
			description: toolDescription,
			parameters: Type.Object({ chars: Type.Optional(Type.Number()) }),
			execute: async (_id, params) => ({
				content: [{ type: "text", text: "x".repeat(typeof params.chars === "number" ? params.chars : 800) }],
				details: {},
			}),
		};
		const harness = await createHarness({
			models: [{ id: "big-window", contextWindow: 1_000_000, maxTokens: 100 }],
			tools: [dumpTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						attempts++;
						if (options.cancelCompaction) return { cancel: true };
						return {
							compaction: {
								summary: "ceiling summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		if (options.seed !== false) seedCompactableSession(harness);
		harness.settingsManager.applyOverrides({
			compaction: { reserveTokens: 100, keepRecentTokens: 1, ceilingTokens: 5000 },
		});
		return Object.assign(harness, { compactionAttempts: () => attempts });
	}

	// Tool turns whose results have `resultChars[i]` characters, with usage reported as the request's real
	// estimated size, as a provider would. `errorAt` makes that request fail once with a retryable 529.
	async function runSizedTurns(
		harness: Harness,
		resultChars: number[],
		options: { prompt?: string; errorAt?: number } = {},
	): Promise<number> {
		let requests = 0;
		let failed = false;
		let turn = 0;
		harness.session.agent.streamFn = (_model, context) => {
			const index = requests++;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (index === options.errorAt && !failed) {
					failed = true;
					const error = createAssistant(harness, {
						stopReason: "error",
						errorMessage: "529 overloaded_error: Overloaded",
					});
					stream.push({ type: "error", reason: "error", error });
					return;
				}
				const last = turn === resultChars.length;
				const message = createAssistant(harness, {
					stopReason: last ? "stop" : "toolUse",
					totalTokens: estimateContextTokens(context).tokens,
				});
				message.content = last
					? [{ type: "text", text: "done" }]
					: [fauxToolCall("dump", { chars: resultChars[turn] })];
				turn++;
				stream.push({ type: "done", reason: message.stopReason, message });
			});
			return stream;
		};
		await harness.session.prompt(options.prompt ?? "start");
		return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
	}

	it("waits until the context grows by what the last compaction kept before compacting again", async () => {
		// Each tool result is about 6000 tokens, more than the 5000 ceiling, so a compaction keeps more
		// than the ceiling and the next one waits for twice what it kept: every other turn, not every turn.
		const harness = await createCeilingHarness("Return a large result");
		expect(await runSizedTurns(harness, Array(6).fill(24_000))).toBe(3);
	});

	it("is not thrown off by a failed request right after a compaction", async () => {
		const plain = await createCeilingHarness("Return a large result");
		const withRetry = await createCeilingHarness("Return a large result");
		withRetry.settingsManager.applyOverrides({ retry: { baseDelayMs: 1 } });
		const expected = await runSizedTurns(plain, Array(6).fill(24_000));
		// Request 1 is the first one after the compaction that the first big result triggers.
		expect(await runSizedTurns(withRetry, Array(6).fill(24_000), { errorAt: 1 })).toBe(expected);
	});

	it("compacts a large first prompt at the configured ceiling", async () => {
		// A fresh session: nothing before the prompt, which is about 4500 tokens on its own.
		const harness = await createCeilingHarness("Return a large result", { seed: false });
		// 2000-character results add about 500 tokens a turn, so the first tool turn crosses 5000.
		expect(await runSizedTurns(harness, [2000, 2000, 2000], { prompt: `start ${"word ".repeat(3600)}` })).toBe(1);
	});

	it("does not retry a failed ceiling compaction until the next prompt", async () => {
		const harness = await createCeilingHarness("Return a large result", { cancelCompaction: true });
		await runToolTurns(harness, [6000, 7000, 8000, 9000, 100]);
		expect(harness.compactionAttempts()).toBe(1);
		await runToolTurns(harness, [9000, 9500, 100]);
		expect(harness.compactionAttempts()).toBe(2);
	});

	it("compacts at the ceiling between tool turns on any provider, inside one prompt", async () => {
		const harness = await createCeilingHarness("Return a large result");
		const sawSummary = await runToolTurns(harness, [3000, 6000, 1000, 100]);
		// The request after the turn that crossed 5000 tokens already carries the summary.
		expect(sawSummary).toEqual([false, false, true, true]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("counts the system prompt and tool schemas when it raises a low ceiling", async () => {
		// About 10k tokens of tool schema raise the 5000-token ceiling to about 20k.
		const harness = await createCeilingHarness("y ".repeat(20_000));
		const sawSummary = await runToolTurns(harness, [15_000, 15_000, 15_000]);
		expect(sawSummary).toEqual([false, false, false]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.session.getCompactionCeiling()?.configured).toBe(5000);
		expect(harness.session.getCompactionCeiling()?.effective).toBeGreaterThan(20_000);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;

		await expect(sessionInternals.runAutoCompaction("threshold", false)).resolves.toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "runAutoCompaction").mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals.checkCompaction(overflowMessage);
		await sessionInternals.checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "runAutoCompaction").mockResolvedValue(false);

		await sessionInternals.checkCompaction(staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "runAutoCompaction").mockResolvedValue(false);

		await sessionInternals.checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "runAutoCompaction").mockResolvedValue(false);

		await sessionInternals.checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = (harness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = vi.spyOn(sessionInternals, "runAutoCompaction").mockResolvedValue(false);

		await sessionInternals.checkCompaction(errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdInternals = (belowThresholdHarness.session as unknown as { _compaction: SessionCompaction })
			._compaction;
		const disabledInternals = (disabledHarness.session as unknown as { _compaction: SessionCompaction })._compaction;
		const belowThresholdSpy = vi.spyOn(belowThresholdInternals, "runAutoCompaction").mockResolvedValue(false);
		const disabledSpy = vi.spyOn(disabledInternals, "runAutoCompaction").mockResolvedValue(false);

		await belowThresholdInternals.checkCompaction(
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await disabledInternals.checkCompaction(
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
