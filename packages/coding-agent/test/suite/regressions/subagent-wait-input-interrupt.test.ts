import type { AgentTool, ImageContent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWaitTool } from "../../../src/builtin-extensions/pi-subagents/src/runs/background/wait-tool.ts";
import type { SubagentState } from "../../../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { awaitWithAbort } from "../../../src/utils/await-with-abort.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("normal Enter during subagent_wait", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("routes the interactive Enter path to a wait handoff instead of steering UI", async () => {
		const editor = {
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
			addToHistory: vi.fn(),
			setText: vi.fn(),
		};
		const interruptSubagentWaitWithPrompt = vi.fn(async () => ({ completion: new Promise<void>(() => {}) }));
		const promptAfterDeferredBuiltins = vi.fn(async () => {});
		const updatePendingMessagesDisplay = vi.fn();
		const context = {
			defaultEditor: editor,
			editor,
			runtimeHost: { isDetached: false, services: { agentDir: "" } },
			transferInProgress: false,
			sessionManager: SessionManager.inMemory(),
			session: {
				isBashRunning: false,
				isCompacting: false,
				isStreaming: true,
				isWaitPromptHandoffActive: true,
				interruptSubagentWaitWithPrompt,
			},
			ui: { setChatScroll: vi.fn(), requestRender: vi.fn() },
			consumeStagedSubmitImages: () => undefined,
			takeSubmittedImages: () => [],
			loadImageAttachments: async () => undefined,
			isExtensionCommand: () => false,
			awaitDeferredBuiltinsForPrompt: async () => {},
			promptAfterDeferredBuiltins,
			updatePendingMessagesDisplay,
			showError: vi.fn(),
		};
		const prototype = InteractiveMode.prototype as unknown as {
			setupEditorSubmitHandler(this: typeof context): void;
		};
		prototype.setupEditorSubmitHandler.call(context);

		await editor.onSubmit?.("continue with this instead");

		expect(interruptSubagentWaitWithPrompt).toHaveBeenCalledWith("continue with this instead", {
			images: undefined,
		});
		expect(promptAfterDeferredBuiltins).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).not.toHaveBeenCalled();
		expect(editor.setText).toHaveBeenCalledWith("");

		context.session.isStreaming = false;
		await editor.onSubmit?.("accepted in the settlement gap");
		expect(interruptSubagentWaitWithPrompt).toHaveBeenLastCalledWith("accepted in the settlement gap", {
			images: undefined,
		});
		expect(promptAfterDeferredBuiltins).not.toHaveBeenCalled();
		context.sessionManager.dispose();
	});

	it("hands input to a fresh run without steering or aborting sibling work", async () => {
		const pendingLaunch = deferred();
		const pendingBarrierStarted = deferred();
		const sibling = deferred();
		const agentEndListener = deferred();
		const settledListenerStarted = deferred();
		const releaseSettledListener = deferred();
		const siblingSignals: Array<AbortSignal | undefined> = [];
		const inputEvents: Array<{ text: string; streamingBehavior?: "steer" | "followUp" }> = [];
		const waitState = { currentSessionId: null } as SubagentState;
		let pendingBarrierStarts = 0;
		let holdFirstAgentEnd = true;
		let holdFirstSettled = true;

		const siblingTool: AgentTool = {
			name: "sibling",
			label: "Sibling",
			description: "Wait for a test signal",
			parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				siblingSignals.push(signal);
				await sibling.promise;
				return { content: [{ type: "text", text: "sibling done" }], details: {} };
			},
		};

		const harness = await createHarness({
			tools: [siblingTool],
			initialActiveToolNames: ["sibling", "subagent_wait"],
			extensionFactories: [
				(pi) => {
					registerWaitTool(pi, waitState, true, async (signal) => {
						pendingBarrierStarts++;
						if (pendingBarrierStarts === 2) pendingBarrierStarted.resolve();
						await awaitWithAbort(pendingLaunch.promise, signal);
					});
					pi.on("input", (event) => {
						inputEvents.push({ text: event.text, streamingBehavior: event.streamingBehavior });
						if (event.text === "next prompt") {
							return { action: "transform", text: "transformed next prompt", images: event.images };
						}
						return { action: "continue" };
					});
					pi.on("agent_end", async () => {
						if (!holdFirstAgentEnd) return;
						holdFirstAgentEnd = false;
						await agentEndListener.promise;
					});
					pi.on("agent_settled", async () => {
						if (!holdFirstSettled) return;
						holdFirstSettled = false;
						settledListenerStarted.resolve();
						await releaseSettledListener.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		waitState.currentSessionId = harness.session.sessionId;
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent_wait", {}), fauxToolCall("subagent_wait", {}), fauxToolCall("sibling", {})],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("fresh response"),
			fauxAssistantMessage("gap response"),
		]);

		const toolStarts = new Set<string>();
		const bothToolsStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "tool_execution_start") return;
				toolStarts.add(event.toolName);
				if (toolStarts.has("subagent_wait") && toolStarts.has("sibling")) {
					unsubscribe();
					resolve();
				}
			});
		});
		const queueEvents: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") queueEvents.push(event);
		});

		const firstPrompt = harness.session.prompt("start");
		await bothToolsStarted;
		await pendingBarrierStarted.promise;
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const handoff = await harness.session.interruptSubagentWaitWithPrompt("next prompt", { images: [image] });

		expect(handoff).toBeDefined();
		expect(queueEvents).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(siblingSignals[0]?.aborted).toBe(false);

		sibling.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(getAssistantTexts(harness)).not.toContain("fresh response");

		agentEndListener.resolve();
		await settledListenerStarted.promise;
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isWaitPromptHandoffActive).toBe(true);
		const gapHandoff = await harness.session.interruptSubagentWaitWithPrompt("gap prompt");
		expect(gapHandoff).toBeDefined();
		releaseSettledListener.resolve();
		await Promise.all([firstPrompt, handoff?.completion, gapHandoff?.completion]);

		expect(inputEvents).toEqual([
			{ text: "start", streamingBehavior: undefined },
			{ text: "next prompt", streamingBehavior: undefined },
			{ text: "gap prompt", streamingBehavior: undefined },
		]);
		expect(getUserTexts(harness)).toEqual(["start", "transformed next prompt", "gap prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["", "fresh response", "gap response"]);
		const secondUser = harness.session.messages.filter((message) => message.role === "user")[1];
		expect(secondUser?.content).toContainEqual(image);
		expect(siblingSignals[0]?.aborted).toBe(false);
	});

	it("releases later sequential waits and delivers rapid submissions in FIFO order", async () => {
		const pendingLaunch = deferred();
		const firstBarrierStarted = deferred();
		const waitState = { currentSessionId: null } as SubagentState;
		let barrierStarts = 0;
		const harness = await createHarness({
			initialActiveToolNames: ["subagent_wait"],
			extensionFactories: [
				(pi) => {
					registerWaitTool(pi, waitState, true, async (signal) => {
						barrierStarts++;
						firstBarrierStarted.resolve();
						await awaitWithAbort(pendingLaunch.promise, signal);
					});
				},
			],
		});
		harnesses.push(harness);
		waitState.currentSessionId = harness.session.sessionId;
		harness.session.agent.toolExecution = "sequential";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent_wait", {}), fauxToolCall("subagent_wait", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("first fresh response"),
			fauxAssistantMessage("second fresh response"),
		]);

		const firstPrompt = harness.session.prompt("start");
		await firstBarrierStarted.promise;
		const firstHandoffPromise = harness.session.interruptSubagentWaitWithPrompt("first prompt");
		const secondHandoffPromise = harness.session.interruptSubagentWaitWithPrompt("second prompt");
		const [firstHandoff, secondHandoff] = await Promise.all([firstHandoffPromise, secondHandoffPromise]);
		expect(firstHandoff).toBeDefined();
		expect(secondHandoff).toBeDefined();

		await Promise.all([firstPrompt, firstHandoff?.completion, secondHandoff?.completion]);

		expect(barrierStarts).toBe(2);
		expect(getUserTexts(harness)).toEqual(["start", "first prompt", "second prompt"]);
		expect(getAssistantTexts(harness)).toEqual(["", "first fresh response", "second fresh response"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});
});
