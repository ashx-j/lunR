import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLAUDE_CODE_EXIT_GRACE_MS,
	CLAUDE_CODE_UPDATE_REQUIRED,
	streamClaudeCode,
} from "../src/api/anthropic-claude-code-bridge.ts";
import { takeClaudeCodeReview } from "../src/api/claude-code-review.ts";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Context, Message } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

/**
 * Stand-in for Claude Code 2.1.310's stream-json mode, matching what the real binary printed against a
 * fixture upstream: replayed user turns get zero-turn results; the Messages request goes straight to
 * ANTHROPIC_BASE_URL; each raw SSE event comes back as a `stream_event` line among other status lines;
 * an HTTP error ends in a `result` carrying `api_error_status`, and a refused connection in one without.
 * In auto mode it reports its starting mode, then reviews each tool call before the `result`: an id ending
 * in "_blocked" gets a classifier `permission_denied` line, any other an MCP `tools/call`. A directory ending
 * in "early" makes those calls before printing the answer, and one ending in "no-auto" starts in default
 * mode and reviews nothing. It records what it received next to itself. With no ANTHROPIC_BASE_URL (or a directory ending in
 * "signed-out") it stops as signed out. A directory ending in "lingers" keeps running briefly after the
 * answer and then writes "exited-cleanly"; one ending in "hangs" never exits. Both leave a "responded"
 * marker once the answer has been read.
 */
const FAKE_CLAUDE_CODE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const frames = [];
let buffer = "";
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const result = (fields) => line({ type: "result", subtype: "success", ...fields });
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
	const settings = JSON.parse(readFileSync(flag("--settings"), "utf8"));
	const extra = JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY);
	const auto = flag("--permission-mode") === "auto" && !__dirname.endsWith("no-auto");
	if (flag("--permission-mode") === "auto") line({ type: "system", subtype: "init", permissionMode: auto ? "auto" : "default" });
	writeFileSync(join(__dirname, "pid"), String(process.pid));
	writeFileSync(join(__dirname, "record.json"), JSON.stringify({ argv, frames, extra, settings, system: readFileSync(flag("--system-prompt-file"), "utf8"), mcp: readFileSync(flag("--mcp-config"), "utf8"), baseUrl: process.env.ANTHROPIC_BASE_URL }));
	if (__dirname.endsWith("signed-out") || !process.env.ANTHROPIC_BASE_URL) {
		result({ is_error: true, result: "Not logged in. Please run /login and include this private detail" });
		process.exit(1);
	}
	line({ type: "system", subtype: "status", status: "requesting" });
	const body = { ...extra, model: flag("--model"), messages: frames.map((frame) => frame.message), stream: true };
	let response;
	try {
		response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", { method: "POST", body: JSON.stringify(body) });
	} catch {
		result({ is_error: true, num_turns: 1, terminal_reason: "api_error", api_error_status: null, result: "API Error: Connection refused" });
		process.exit(1);
	}
	const text = await response.text();
	writeFileSync(join(__dirname, "responded"), "");
	if (response.status === 200) {
		const review = async () => {
			const mcpUrl = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.lunr.url;
			for (const event of auto ? text.split("\\n\\n") : []) {
				const data = event.split("\\n").find((row) => row.startsWith("data: "));
				const block = data && JSON.parse(data.slice(6)).content_block;
				if (block?.type !== "tool_use") continue;
				if (block.id.endsWith("_blocked")) {
					line({ type: "system", subtype: "permission_denied", tool_use_id: block.id, decision_reason_type: "classifier", decision_reason: "[Create Public Surface]" });
					continue;
				}
				const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read", arguments: {}, _meta: { "claudecode/toolUseId": block.id } } };
				await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call) });
			}
		};
		if (__dirname.endsWith("early")) await review();
		for (const event of text.split("\\n\\n")) {
			const data = event.split("\\n").find((row) => row.startsWith("data: "));
			if (data) line({ type: "stream_event", event: JSON.parse(data.slice(6)), parent_tool_use_id: null });
			line({ type: "system", subtype: "thinking_tokens" });
		}
		if (!__dirname.endsWith("early")) await review();
	} else {
		line({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] }, error: "unknown" });
	}
	if (response.status === 200) result({ is_error: false, num_turns: 1 });
	else result({ is_error: true, num_turns: 1, terminal_reason: "api_error", api_error_status: response.status, result: "API Error: " + response.status + " " + JSON.parse(text).error.type });
	if (__dirname.endsWith("lingers")) {
		await new Promise((resolve) => setTimeout(resolve, 400));
		writeFileSync(join(__dirname, "exited-cleanly"), "");
	}
	if (__dirname.endsWith("hangs")) setInterval(() => {}, 1000);
});
`;

const sse = (...events: object[]) =>
	events.map((event) => `event: ${"type" in event ? event.type : ""}\ndata: ${JSON.stringify(event)}\n\n`).join("");

function toolCallAnswer(toolName: string, extraToolId?: string): string {
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
		...(extraToolId
			? [
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: extraToolId, name: toolName, input: {} },
					},
					{
						type: "content_block_delta",
						index: 2,
						delta: { type: "input_json_delta", partial_json: '{"path":"c.txt"}' },
					},
					{ type: "content_block_stop", index: 2 },
				]
			: []),
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
		connection: {
			type: "external_claude_code",
			version: 3,
			manager: "claude-code",
			command,
			models: [{ id: "claude-opus-4-8", route: "claude-opus-4-8[1m]", contextWindow: 1_000_000 }],
		},
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
		expect(record.argv).toEqual(
			expect.arrayContaining(["--model", "claude-opus-4-8[1m]", "--max-turns", "1", "--include-partial-messages"]),
		);
		expect(record.argv[record.argv.indexOf("--tools") + 1]).toBe("");
		// Claude Code reaches the upstream itself; lunR is not in between.
		expect(record.baseUrl).toBe(upstream);
		// The MCP config is a file, and its secret path does not appear on the command line.
		const mcpUrl = new URL(JSON.parse(record.mcp).mcpServers.lunr.url);
		const mcpSecret = mcpUrl.pathname.split("/")[1];
		expect(mcpUrl.pathname).toBe(`/${mcpSecret}/mcp`);
		expect(record.argv.join("\n")).not.toContain(mcpSecret);
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

	it("leaves Claude Code's own Anthropic endpoint in place outside tests", async () => {
		const { connection, directory } = await setup({ status: 500, body: "unreachable" });
		const result = await streamClaudeCode(model, context, { externalClaudeCode: connection }, true).result();
		expect(result.errorMessage).toBe("Claude Code is not signed in to a Claude subscription. Run /login anthropic.");
		expect(JSON.parse(readFileSync(join(directory, "record.json"), "utf8")).baseUrl).toBeUndefined();
	});

	it("reports a connection Claude Code could not make as a retryable network error", async () => {
		const { connection } = await setup({ status: 200, body: "" });
		const result = await streamClaudeCode(
			model,
			context,
			{ externalClaudeCode: connection },
			true,
			"http://127.0.0.1:1",
		).result();
		expect(result.errorMessage).toMatch(/^Claude Code network error: /);
		expect(isRetryableAssistantError(result)).toBe(true);
	});

	it("ends an answer that stops before message_stop as a retryable error", async () => {
		const answer = toolCallAnswer("mcp__lunr__read");
		const { connection, upstream } = await setup({
			status: 200,
			body: answer.slice(0, answer.indexOf("event: content_block_start")),
		});
		const result = await streamClaudeCode(
			model,
			context,
			{ externalClaudeCode: connection },
			true,
			upstream,
		).result();
		expect(result.stopReason).toBe("error");
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

	describe("stopping Claude Code after an upstream error", () => {
		const unauthorized = {
			status: 401,
			body: JSON.stringify({ type: "error", error: { type: "authentication_error" } }),
		};
		const alive = (pidFile: string) => {
			try {
				process.kill(Number(readFileSync(pidFile, "utf8")), 0);
				return true;
			} catch {
				return false;
			}
		};
		const until = async (condition: () => boolean) => {
			for (let waited = 0; !condition() && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
		};

		it("lets Claude Code finish its own exit before killing it", async () => {
			const { connection, upstream, directory } = await setup(unauthorized, "lingers");
			const result = await streamClaudeCode(
				model,
				context,
				{ externalClaudeCode: connection },
				true,
				upstream,
			).result();
			expect(result.errorMessage).toMatch(/^401 /);
			// A kill right after the error body would have ended the process before it wrote this.
			expect(existsSync(join(directory, "exited-cleanly"))).toBe(true);
		});

		it("kills a Claude Code that is still running after the grace period", async () => {
			const { connection, upstream, directory } = await setup(unauthorized, "hangs");
			const started = Date.now();
			const result = await streamClaudeCode(
				model,
				context,
				{ externalClaudeCode: connection },
				true,
				upstream,
			).result();
			expect(result.errorMessage).toMatch(/^401 /);
			expect(Date.now() - started).toBeGreaterThanOrEqual(CLAUDE_CODE_EXIT_GRACE_MS - 100);
			await until(() => !alive(join(directory, "pid")));
			expect(alive(join(directory, "pid"))).toBe(false);
		}, 15_000);

		it("kills Claude Code promptly when the user aborts during the grace period", async () => {
			const { connection, upstream, directory } = await setup(unauthorized, "hangs");
			const controller = new AbortController();
			const running = streamClaudeCode(
				model,
				context,
				{ externalClaudeCode: connection, signal: controller.signal },
				true,
				upstream,
			).result();
			await until(() => existsSync(join(directory, "responded")));
			const aborted = Date.now();
			controller.abort();
			await running;
			expect(Date.now() - aborted).toBeLessThan(CLAUDE_CODE_EXIT_GRACE_MS / 2);
			await until(() => !alive(join(directory, "pid")));
			expect(alive(join(directory, "pid"))).toBe(false);
		}, 15_000);
	});

	it("lets Claude Code's auto mode review the answer's tool calls", async () => {
		const answer = toolCallAnswer("mcp__lunr__read", "toolu_3_blocked");
		const { connection, upstream, directory } = await setup({ status: 200, body: answer });
		const autoMode = { allowTools: ["read", "grep"] };
		const options = { externalClaudeCode: connection, claudeCodeAutoMode: autoMode };
		const result = await streamClaudeCode(model, context, options, true, upstream).result();

		expect(result.stopReason).toBe("toolUse");
		await expect(takeClaudeCodeReview("toolu_2")).resolves.toEqual({ decision: "allow" });
		await expect(takeClaudeCodeReview("toolu_3_blocked")).resolves.toEqual({
			decision: "block",
			reason: "[Create Public Surface]",
		});
		const record = JSON.parse(readFileSync(join(directory, "record.json"), "utf8"));
		expect(record.argv[record.argv.indexOf("--permission-mode") + 1]).toBe("auto");
		// Only offered tools are allowed past the reviewer.
		expect(record.settings.permissions).toEqual({ allow: ["mcp__lunr__read"] });
	});

	it("keeps an allow that reaches the loopback before its tool call is read", async () => {
		const { connection, upstream } = await setup({ status: 200, body: toolCallAnswer("mcp__lunr__read") }, "early");
		const options = { externalClaudeCode: connection, claudeCodeAutoMode: { allowTools: [] } };
		await streamClaudeCode(model, context, options, true, upstream).result();
		await expect(takeClaudeCodeReview("toolu_2")).resolves.toEqual({ decision: "allow" });
	});

	it("reports no review when Claude Code starts outside auto mode", async () => {
		const { connection, upstream } = await setup({ status: 200, body: toolCallAnswer("mcp__lunr__read") }, "no-auto");
		const options = { externalClaudeCode: connection, claudeCodeAutoMode: { allowTools: [] } };
		await streamClaudeCode(model, context, options, true, upstream).result();
		await expect(takeClaudeCodeReview("toolu_2")).resolves.toMatchObject({ decision: "unavailable" });
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

	it("asks connections without saved routes and windows to set up again", async () => {
		for (const version of [1, 2] as const) {
			const result = await anthropicProvider()
				.streamSimple(model, context, {
					externalClaudeCode: { type: "external_claude_code", version, manager: "claude-code", command: "/x" },
				})
				.result();
			expect(result.errorMessage).toBe(CLAUDE_CODE_UPDATE_REQUIRED);
		}
	});
});
