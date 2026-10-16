import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CODE_UPDATE_REQUIRED, streamClaudeCode } from "../src/api/anthropic-claude-code-bridge.ts";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Context, Message } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

/**
 * Stand-in for Claude Code's stream-json mode: acknowledges replayed user turns with zero-turn results,
 * records what it received next to itself, then sends one Messages request to ANTHROPIC_BASE_URL.
 */
const FAKE_CLAUDE_CODE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const frames = [];
let buffer = "";
const result = (fields) => process.stdout.write(JSON.stringify({ type: "result", subtype: "success", ...fields }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
		const frame = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		frames.push(frame);
		if (frame.shouldQuery === false) result({ num_turns: 0, is_error: false });
	}
});
process.stdin.on("end", async () => {
	const extra = JSON.parse(JSON.parse(readFileSync(flag("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
	writeFileSync(join(__dirname, "record.json"), JSON.stringify({ argv, frames, extra, system: readFileSync(flag("--system-prompt-file"), "utf8") }));
	if (__dirname.endsWith("signed-out")) {
		result({ is_error: true, result: "Not logged in. Please run /login and include this private detail" });
		process.exit(1);
	}
	const body = { ...extra, model: flag("--model"), messages: frames.map((frame) => frame.message), stream: true };
	const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", { method: "POST", body: JSON.stringify(body) });
	await response.text();
	result({ is_error: response.status !== 200, num_turns: 1 });
});
`;

const sse = (...events: object[]) =>
	events.map((event) => `event: ${"type" in event ? event.type : ""}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function toolCallAnswer(toolName: string): string {
	return sse(
		{
			type: "message_start",
			message: {
				id: "msg_fixture",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-8",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Next file." } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-new" } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "toolu_2", name: toolName, input: {} },
		},
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"b.txt"}' } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
		{ type: "message_stop" },
	);
}

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Starts a fixture upstream and a fake Claude Code; `name` ending in "signed-out" makes the fake stop early. */
async function setup(
	upstreamAnswer: { status: number; body: string },
	name = "claude-code",
): Promise<{ connection: ExternalClaudeCodeCredential; upstream: string; directory: string }> {
	const root = mkdtempSync(join(tmpdir(), "lunr-claude-bridge-"));
	directories.push(root);
	const directory = join(root, name);
	mkdirSync(directory);
	const command = join(directory, "claude");
	writeFileSync(command, FAKE_CLAUDE_CODE);
	chmodSync(command, 0o755);
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(upstreamAnswer.status, {
				"content-type": upstreamAnswer.status === 200 ? "text/event-stream" : "application/json",
			});
			res.end(upstreamAnswer.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	const address = server.address();
	return {
		connection: { type: "external_claude_code", version: 2, manager: "claude-code", command },
		upstream: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
		directory,
	};
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const history: Message[] = [
	{ role: "user", content: "Read a.txt", timestamp: 1 },
	{
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		content: [
			{ type: "thinking", thinking: "Need a.txt.", thinkingSignature: "sig-old" },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } },
		],
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	},
	{
		role: "toolResult",
		toolCallId: "toolu_1",
		toolName: "read",
		content: [{ type: "text", text: "contents of a" }],
		isError: false,
		timestamp: 3,
	},
	{ role: "user", content: "Now b.txt", timestamp: 4 },
];
const context: Context = {
	systemPrompt: "You are lunR.",
	messages: history,
	tools: [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	],
};
const model = ANTHROPIC_MODELS["claude-opus-4-8"];

describe.skipIf(process.platform === "win32")("Claude Code subscription bridge", () => {
	it("replays history through Claude Code and returns the upstream turn with lunR tool names", async () => {
		const { connection, upstream, directory } = await setup({ status: 200, body: toolCallAnswer("mcp__lunr__read") });
		const result = await streamClaudeCode(
			model,
			context,
			{ reasoning: "high", externalClaudeCode: connection },
			true,
			upstream,
		).result();

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "Next file.", thinkingSignature: "sig-new" },
			{ type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "b.txt" } },
		]);

		const record = JSON.parse(readFileSync(join(directory, "record.json"), "utf8"));
		expect(record.argv).toEqual(expect.arrayContaining(["--model", "claude-opus-4-8[1m]", "--max-turns", "1"]));
		expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe("");
		expect(JSON.parse(record.argv[record.argv.indexOf("--mcp-config") + 1]).mcpServers.lunr.type).toBe("http");
		expect(record.system).toBe("You are lunR.");
		expect(
			record.frames.map((frame: { type: string; shouldQuery?: boolean }) => [frame.type, frame.shouldQuery]),
		).toEqual([
			["user", false],
			["assistant", undefined],
			["user", undefined],
		]);
		// Claude Code keeps signed thinking only when the replayed turn names its model.
		expect(record.frames[1].message).toEqual({
			role: "assistant",
			model: "claude-opus-4-8",
			content: [
				{ type: "thinking", thinking: "Need a.txt.", signature: "sig-old" },
				{ type: "tool_use", id: "toolu_1", name: "mcp__lunr__read", input: { path: "a.txt" } },
			],
		});
		expect(record.frames[2].message.content.map((block: { type: string }) => block.type)).toEqual([
			"tool_result",
			"text",
		]);
		expect(record.extra.tools.map((tool: { name: string }) => tool.name)).toEqual(["mcp__lunr__read"]);
		expect(record.extra.output_config).toEqual({ effort: "high" });
	});

	it("accepts an explicit automatic tool choice", async () => {
		const { connection, upstream } = await setup({ status: 200, body: toolCallAnswer("mcp__lunr__read") });
		const options = { externalClaudeCode: connection, toolChoice: "auto" as const };
		const result = await streamClaudeCode(model, context, options, false, upstream).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
	});

	it("passes upstream errors through with their status so retries match the API-key route", async () => {
		const { connection, upstream } = await setup({
			status: 429,
			body: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } }),
		});
		const result = await streamClaudeCode(
			model,
			context,
			{ externalClaudeCode: connection },
			true,
			upstream,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/^429 .*rate_limit_error/);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("explains a Claude Code exit before any upstream request without passing native text through", async () => {
		const { connection, upstream } = await setup({ status: 500, body: "unreachable" }, "signed-out");
		const result = await streamClaudeCode(
			model,
			context,
			{ externalClaudeCode: connection },
			true,
			upstream,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Claude Code is not signed in to a Claude subscription. Run /login anthropic.");
	});

	it("rejects tool calls for tools lunR did not offer", async () => {
		const { connection, upstream } = await setup({ status: 200, body: toolCallAnswer("mcp__lunr__bash") });
		const result = await streamClaudeCode(
			model,
			context,
			{ externalClaudeCode: connection },
			true,
			upstream,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("outside lunR's tool list");
	});

	it("asks connections from the retired Python bridge to set up again", async () => {
		const result = await anthropicProvider()
			.streamSimple(model, context, {
				externalClaudeCode: { type: "external_claude_code", version: 1, manager: "claude-code", command: "/x" },
			})
			.result();
		expect(result.errorMessage).toBe(CLAUDE_CODE_UPDATE_REQUIRED);
	});
});
