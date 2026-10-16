import { resolve } from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/notify.ts";
import { acpWorkerArgs } from "../src/modes/acp/args.ts";
import type { AcpRpcProcess, WorkerEvent } from "../src/modes/acp/process.ts";
import { AcpSession } from "../src/modes/acp/session.ts";
import { customMessageContent, customMessageUpdates, modelOptions, promptToLunr } from "../src/modes/acp/translate.ts";

describe("ACP command and content boundaries", () => {
	it("resolves launch paths before switching to a client project", () => {
		expect(
			acpWorkerArgs([
				"--mode",
				"acp",
				"--extension",
				"./plugin.ts",
				"--skill",
				"npm:skills",
				"--system-prompt",
				"--mode",
			]),
		).toEqual(["--extension", resolve("plugin.ts"), "--skill", "npm:skills", "--system-prompt", "--mode"]);
	});

	it("treats launch model and reasoning as new-session defaults", () => {
		expect(
			acpWorkerArgs(["--model", "provider/model", "--thinking", "low", "--name", "first", "--offline"], true),
		).toEqual(["--offline"]);
	});

	it("rejects a CLI-owned conversation in ACP mode", () => {
		expect(() => acpWorkerArgs(["--session", "/tmp/session.jsonl"])).toThrow("clients own prompts");
		expect(() => acpWorkerArgs(["do some work"])).toThrow("clients own prompts");
	});

	it("preserves image and embedded text attachments", () => {
		expect(
			promptToLunr([
				{ type: "text", text: "review" },
				{ type: "resource", resource: { uri: "file:///project/notes.txt", text: "attached context" } },
				{ type: "image", data: "image-data", mimeType: "image/png" },
			]),
		).toEqual({
			message: "review\n[embedded context] file:///project/notes.txt\nattached context",
			images: [{ type: "image", data: "image-data", mimeType: "image/png" }],
		});
	});

	it("rejects unsupported attachments instead of silently dropping them", () => {
		expect(() => promptToLunr([{ type: "audio", data: "audio", mimeType: "audio/wav" }])).toThrow("audio");
		expect(() => promptToLunr([{ type: "resource", resource: { uri: "file:///file.pdf", blob: "binary" } }])).toThrow(
			"Binary",
		);
	});

	it("exposes final native subagent cards without exposing unrelated hidden messages", () => {
		const message = {
			role: "custom" as const,
			customType: "internal",
			content: "private context",
			display: false,
			timestamp: 0,
		};
		expect(customMessageContent(message)).toEqual([]);
		expect(
			customMessageContent({ ...message, customType: "subagent-slash-result", content: "child report" }),
		).toEqual([{ type: "text", text: "child report" }]);
	});

	it.each([
		{ state: "complete", success: true, status: "completed" },
		{ state: "failed", success: false, status: "failed" },
		{ state: "paused", success: false, status: "failed" },
		{ state: "stopped", success: false, status: "failed" },
	])("preserves the outcome of a $state native child notice", ({ state, success, status }) => {
		const content = formatSingleCompletion(
			buildCompletionDetails({
				id: "fixture-run",
				agent: "fixture child",
				success,
				state,
				summary: "native outcome",
				timestamp: 0,
			}),
		);
		expect(
			customMessageUpdates({
				role: "custom",
				customType: "subagent-notify",
				content,
				display: true,
				timestamp: 0,
			}),
		).toEqual([expect.objectContaining({ sessionUpdate: "tool_call", status })]);
	});

	it("does not report an unrecognized child notice as completed", () => {
		const notify = (content: string) =>
			customMessageUpdates({ role: "custom", customType: "subagent-notify", content, display: true, timestamp: 0 });
		expect(notify("Background task exploded: **fixture child**\n\nunexpected wording")).toEqual([
			expect.objectContaining({ status: "failed" }),
		]);
		expect(notify("something else entirely")).toEqual([expect.objectContaining({ status: "failed" })]);
	});

	it("reports a grouped batch of completed children as completed", () => {
		const details = ["first", "second"].map((agent) =>
			buildCompletionDetails({ id: agent, agent, success: true, state: "complete", summary: "done", timestamp: 0 }),
		);
		expect(
			customMessageUpdates({
				role: "custom",
				customType: "subagent-notify",
				content: formatGroupedCompletion(details),
				display: true,
				timestamp: 0,
			}),
		).toEqual([expect.objectContaining({ sessionUpdate: "tool_call", status: "completed" })]);
	});

	describe("model picker labels", () => {
		const model = (provider: string, id: string, name: string) => ({ provider, id, name });
		const labels = (models: ReturnType<typeof model>[]) => modelOptions(models).map((option) => option.name);

		it("keeps unique names plain and values as provider/id", () => {
			const options = modelOptions([model("a", "x", "Alpha"), model("b", "y", "Beta")]);
			expect(options).toEqual([
				{ value: "a/x", name: "Alpha" },
				{ value: "b/y", name: "Beta" },
			]);
		});

		it("adds the provider when a name appears under different providers", () => {
			expect(labels([model("a", "x", "Same"), model("b", "x", "Same"), model("a", "z", "Other")])).toEqual([
				"Same (a)",
				"Same (b)",
				"Other",
			]);
		});

		it("adds the id when a name repeats within one provider", () => {
			expect(labels([model("a", "x", "Same"), model("a", "y", "Same")])).toEqual(["Same (a/x)", "Same (a/y)"]);
		});

		it("disambiguates only the colliding entries in a three-way collision", () => {
			expect(labels([model("a", "x", "Same"), model("b", "x", "Same"), model("b", "y", "Same")])).toEqual([
				"Same (a)",
				"Same (b/x)",
				"Same (b/y)",
			]);
		});
	});
});

describe("ACP session updates", () => {
	function streamingFixture() {
		let send: (event: WorkerEvent) => void = () => {};
		const worker = {
			onEvent(listener: (event: WorkerEvent) => void) {
				send = listener;
				return () => {};
			},
			onExit: () => () => {},
		};
		const updates: SessionNotification["update"][] = [];
		const session = new AcpSession(
			"session",
			"/project",
			worker as unknown as AcpRpcProcess,
			{
				sessionUpdate: async ({ update }) => {
					updates.push(update);
				},
				requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
				unstable_createElicitation: async () => ({ action: "cancel" }),
			},
			{},
			async () => {},
		);
		const partial = (call: ToolCall): AssistantMessage => ({
			role: "assistant",
			content: [call],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		});
		return { session, updates, send, partial };
	}

	it("sends a streamed tool call once at start and once with its final input", async () => {
		const { session, updates, send, partial } = streamingFixture();
		const call = (content: string): ToolCall => ({
			type: "toolCall",
			id: "write-call",
			name: "write",
			arguments: { path: "big.txt", content },
		});
		const update = (
			assistantMessageEvent: Extract<WorkerEvent, { type: "message_update" }>["assistantMessageEvent"],
		) => send({ type: "message_update", message: assistantMessageEvent.partial, assistantMessageEvent });
		update({ type: "toolcall_start", contentIndex: 0, partial: partial(call("")) });
		for (let size = 1; size <= 200; size++)
			update({ type: "toolcall_delta", contentIndex: 0, delta: "x", partial: partial(call("x".repeat(size))) });
		const final = call("x".repeat(200));
		update({ type: "toolcall_end", contentIndex: 0, toolCall: final, partial: partial(final) });
		await session.flush();
		expect(updates).toHaveLength(2);
		expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "write-call", status: "pending" });
		expect(updates[1]).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "write-call",
			rawInput: { path: "big.txt", content: "x".repeat(200) },
		});
	});

	it("still announces a tool call when the provider streams deltas without a start event", async () => {
		const { session, updates, send, partial } = streamingFixture();
		const call: ToolCall = { type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "ls" } };
		send({
			type: "message_update",
			message: partial(call),
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "ls", partial: partial(call) },
		});
		await session.flush();
		expect(updates).toEqual([expect.objectContaining({ sessionUpdate: "tool_call", title: "ls" })]);
	});
});
