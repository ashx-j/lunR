import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamClaudeCode } from "../src/api/anthropic-claude-code-bridge.ts";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { cleanupConversationResources, cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Context, Message, StreamOptions } from "../src/types.ts";

/**
 * Stand-in for a long-lived Claude Code 2.1.310 in stream-json mode, matching what the real binary did
 * against a fixture upstream: it keeps its own history from the frames it reads, queries on every frame
 * without `shouldQuery: false`, runs tool calls through the MCP endpoint with the tool use id in `_meta`,
 * and keeps querying until an answer ends its turn. Like 2.1.310 it moves text that follows a tool call
 * ahead of the tool calls in its own copy. Fields from CLAUDE_CODE_EXTRA_BODY replace its own, so a
 * one-shot process (with `messages` there) sends the body's history. A live process prints a compaction
 * line before querying when the newest user text says COMPACT, a compaction status line for STATUS_LINE,
 * a hook line for HOOKLINE, a note after an `end_turn` answer for TAILNOTE, calls the answer's tools in
 * reverse order for REVERSE, and refuses without a request for REFUSE, as Claude Code does near its own
 * context limit. It reads each answer as it streams, calls a tool as soon as its block ends, and rewrites
 * tool results the way 2.1.310 does. Each process appends "<pid> oneshot|session" to `pids` next to itself.
 */
const FAKE_CLAUDE_CODE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const oneShot = argv.includes("--max-turns");
appendFileSync(join(__dirname, "pids"), process.pid + (oneShot ? " oneshot" : " session") + "\\n");
const extra = JSON.parse(JSON.parse(readFileSync(flag("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
const mcpUrl = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.lunr.url;
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const history = [];
let queue = Promise.resolve();
// Claude Code 2.1.310's own rewrites of an MCP result, as measured against a recording upstream.
function recorded(call, result) {
	const text = result.content.map((item) => item.text).join("\\n");
	if (!result.isError) return text.trim() ? result.content : "(" + call.name + " completed with no output)";
	const trimmed = text.trim();
	if (!trimmed) return "Command failed with no output";
	if (trimmed.length <= 11024) return trimmed;
	return trimmed.slice(0, 5000) + "\\n\\n... [" + (trimmed.length - 10000) + " characters truncated] ...\\n\\n" + trimmed.slice(-5000);
}
async function callTool(call) {
	const reply = await fetch(mcpUrl, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.input, _meta: { "claudecode/toolUseId": call.id } } }) });
	const data = (await reply.text()).split("\\n").find((row) => row.startsWith("data: "));
	const { result } = JSON.parse(data.slice(6));
	return { type: "tool_result", tool_use_id: call.id, content: recorded(call, result), ...(result.isError ? { is_error: true } : {}) };
}
async function query() {
	line({ type: "system", subtype: "init" });
	for (;;) {
		const asked = JSON.stringify(history.at(-1));
		if (!oneShot && asked.includes("COMPACT")) line({ type: "system", subtype: "compact_boundary" });
		if (!oneShot && asked.includes("STATUS_LINE")) line({ type: "system", subtype: "status", status: null, compact_result: "success" });
		if (!oneShot && asked.includes("HOOKLINE")) line({ type: "system", subtype: "hook_started" });
		if (!oneShot && asked.includes("REFUSE")) {
			line({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Prompt is too long" });
			return;
		}
		const body = { model: flag("--model"), messages: history, ...extra, stream: true };
		const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify(body) });
		if (response.status !== 200) {
			await response.text();
			line({ type: "result", is_error: true, num_turns: 1, api_error_status: response.status, result: "API Error" });
			return;
		}
		// Like Claude Code, read the answer as it streams and call each tool as soon as its block ends.
		const reverse = asked.includes("REVERSE");
		const content = [];
		const calls = [];
		let stop;
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of response.body) {
			pending += decoder.decode(chunk, { stream: true });
			for (let end = pending.indexOf("\\n\\n"); end >= 0; end = pending.indexOf("\\n\\n")) {
				const data = pending.slice(0, end).split("\\n").find((row) => row.startsWith("data: "));
				pending = pending.slice(end + 2);
				if (!data) continue;
				const event = JSON.parse(data.slice(6));
				line({ type: "stream_event", event });
				if (event.type === "content_block_start") content[event.index] = { ...event.content_block };
				if (event.type === "content_block_delta" && event.delta.type === "text_delta") content[event.index].text += event.delta.text;
				if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") content[event.index].input = JSON.parse(event.delta.partial_json);
				if (event.type === "content_block_stop" && content[event.index].type === "tool_use" && !oneShot && !reverse) calls.push(callTool(content[event.index]));
				if (event.type === "message_delta") stop = event.delta.stop_reason;
			}
		}
		const kept = content.map(({ caller, ...block }) => block);
		const firstTool = kept.findIndex((block) => block.type === "tool_use");
		const tail = firstTool < 0 ? [] : kept.slice(firstTool);
		history.push({ role: "assistant", content: firstTool < 0 ? kept : [...kept.slice(0, firstTool), ...tail.filter((b) => b.type === "text"), ...tail.filter((b) => b.type !== "text")] });
		if (stop !== "tool_use" || oneShot) {
			if (asked.includes("TAILNOTE")) line({ type: "system", subtype: "informational" });
			line({ type: "result", is_error: false, num_turns: 1 });
			return;
		}
		if (reverse) {
			const ordered = kept.filter((block) => block.type === "tool_use");
			const started = new Map(ordered.reverse().map((call) => [call.id, callTool(call)]));
			calls.push(...ordered.reverse().map((call) => started.get(call.id)));
		}
		const results = await Promise.all(calls);
		history.push({ role: "user", content: results });
		line({ type: "user", message: { role: "user", content: results } });
	}
}
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
		const frame = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		history.push(frame.message);
		if (frame.shouldQuery === false) line({ type: "result", num_turns: 0, is_error: false });
		else if (frame.type === "user") queue = queue.then(query);
	}
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
`;

const sse = (...events: object[]) =>
	events.map((event) => `event: ${"type" in event ? event.type : ""}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/**
 * An upstream answer: `read` tool calls for the paths in `step` (joined by "+", followed by a text block
 * when `step` ends in "|after"), or text that ends the turn.
 */
function answer(index: number, step?: string): string {
	const after = step?.endsWith("|after") ?? false;
	const paths = (after ? step?.slice(0, -"|after".length) : step)?.split("+") ?? [];
	const blocks: { block: object; delta: object }[] = paths.length
		? paths.map((path, call) => ({
				block: {
					type: "tool_use",
					id: call ? `toolu_${index}_${call}` : `toolu_${index}`,
					name: "mcp__lunr__read",
					input: {},
					caller: { type: "direct" },
				},
				delta: { type: "input_json_delta", partial_json: JSON.stringify({ path }) },
			}))
		: [{ block: { type: "text", text: "" }, delta: { type: "text_delta", text: "done" } }];
	if (after) blocks.push({ block: { type: "text", text: "" }, delta: { type: "text_delta", text: "after the call" } });
	return sse(
		{
			type: "message_start",
			message: {
				id: `msg_${index}`,
				type: "message",
				role: "assistant",
				model: "claude-opus-4-8",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		},
		...blocks.flatMap(({ block, delta }, blockIndex) => [
			{ type: "content_block_start", index: blockIndex, content_block: block },
			{ type: "content_block_delta", index: blockIndex, delta },
			{ type: "content_block_stop", index: blockIndex },
		]),
		{
			type: "message_delta",
			delta: { stop_reason: paths.length ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	);
}

const directories: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
	cleanupSessionResources();
	for (const close of closers.splice(0)) close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A fixture upstream that answers with a `read` call until `script` says otherwise, records every body,
 * and a fake Claude Code. `script(n)` returns the path to read on request n, undefined for a final text
 * answer, or an HTTP status to fail with. `gap` holds the answer's end (`message_delta` on) back, as the
 * real API can after a tool block. `result` gives lunR's tool result for a path.
 */
async function setup(
	script: (request: number) => string | number | undefined = (n) => `file-${n}`,
	{ gap = 0, result }: { gap?: number; result?: (path: string) => { text: string; isError?: boolean } } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "lunr-claude-session-"));
	directories.push(directory);
	const command = join(directory, "claude");
	writeFileSync(command, FAKE_CLAUDE_CODE);
	chmodSync(command, 0o755);
	const bodies: { messages: { role: string; content: unknown }[] }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			bodies.push(JSON.parse(body));
			const step = script(bodies.length);
			if (typeof step === "number") {
				res.writeHead(step, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "down" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const all = answer(bodies.length, step);
			const cut = all.indexOf("event: message_delta");
			if (!gap || cut < 0) return void res.end(all);
			res.write(all.slice(0, cut));
			setTimeout(() => res.end(all.slice(cut)), gap);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	const address = server.address();
	const connection: ExternalClaudeCodeCredential = {
		type: "external_claude_code",
		version: 3,
		manager: "claude-code",
		command,
		models: [
			{ id: "claude-opus-4-8", route: "claude-opus-4-8" },
			{ id: "claude-sonnet-5-5", route: "claude-sonnet-5-5" },
		],
	};
	const upstream = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	const spawns = () =>
		readFileSync(join(directory, "pids"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((row) => row.split(" "));
	const pids = () => spawns().map(([pid]) => Number(pid));
	const sessionPids = () => spawns().flatMap(([pid, kind]) => (kind === "session" ? [Number(pid)] : []));
	return { connection, upstream, bodies, pids, sessionPids, result };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Waits for Claude Code processes to be reaped after a kill. */
async function settled(pids: number[]): Promise<boolean> {
	for (let attempt = 0; attempt < 50 && pids.some(alive); attempt++) await new Promise((r) => setTimeout(r, 20));
	return !pids.some(alive);
}

const tools: Context["tools"] = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

type Fixture = Awaited<ReturnType<typeof setup>>;

describe.skipIf(process.platform === "win32")("Claude Code session process", () => {
	/** Runs lunR's agent loop for `turns` requests: each tool call gets a text result. */
	async function run(
		setupResult: Fixture,
		turns: number,
		options: Partial<StreamOptions> & { reasoning?: "high" | "low" } = {},
		messages: Message[] = [{ role: "user", content: "Read files", timestamp: 0 }],
		context: Partial<Context> = {},
	): Promise<{ messages: Message[]; last: AssistantMessage }> {
		const model = ANTHROPIC_MODELS["claude-opus-4-8"];
		let last: AssistantMessage | undefined;
		for (let turn = 0; turn < turns; turn++) {
			last = await streamClaudeCode(
				model,
				{ systemPrompt: "You are lunR.", messages, tools, ...context },
				{ externalClaudeCode: setupResult.connection, sessionId: "session-a", ...options },
				true,
				setupResult.upstream,
			).result();
			expect(last.errorMessage).toBeUndefined();
			messages.push(last);
			const calls = last.content.flatMap((block) => (block.type === "toolCall" ? [block] : []));
			if (!calls.length) break;
			for (const call of calls) {
				const path = String(call.arguments.path);
				const { text, isError = false } = setupResult.result?.(path) ?? { text: `contents of ${path}` };
				messages.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text }],
					isError,
					timestamp: turn,
				});
			}
		}
		if (!last) throw new Error("no turn ran");
		return { messages, last };
	}

	it("keeps one process for every request that continues the held history", async () => {
		const fixture = await setup();
		await run(fixture, 5);
		// One process for the first request, one live process for the four after it.
		expect(fixture.pids()).toHaveLength(2);
		const last = fixture.bodies[4]?.messages;
		expect(last?.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
		]);
		expect(last?.at(-1)?.content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_4", content: [{ type: "text", text: "contents of file-4" }] },
		]);
	});

	it("sends a new user turn to the live process after a finished answer", async () => {
		const fixture = await setup((n) => (n === 3 ? undefined : `file-${n}`));
		const { messages } = await run(fixture, 3);
		messages.push({ role: "user", content: "Again", timestamp: 9 });
		await run(fixture, 1, {}, messages);
		expect(fixture.pids()).toHaveLength(2);
		expect(fixture.bodies[3]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Again" }]);
	});

	const mismatches: [string, (fixture: Fixture, messages: Message[]) => Promise<unknown>][] = [
		["a thinking change", (fixture, messages) => run(fixture, 1, { reasoning: "low" }, messages)],
		["a system prompt change", (fixture, messages) => run(fixture, 1, {}, messages, { systemPrompt: "Changed." })],
		[
			"a tool list change",
			(fixture, messages) =>
				run(fixture, 1, {}, messages, { tools: [{ ...tools[0], description: "Read one file" }] }),
		],
		[
			"an edited history",
			(fixture, messages) =>
				run(fixture, 1, {}, [{ role: "user", content: "Edited", timestamp: 0 }, ...messages.slice(1)]),
		],
		[
			// Claude Code records an empty MCP result differently, so lunR's empty output is not handed over.
			"a tool result Claude Code would record differently",
			(fixture, messages) => {
				const last = messages.at(-1);
				if (last?.role !== "toolResult") throw new Error("expected a tool result");
				return run(fixture, 1, {}, [...messages.slice(0, -1), { ...last, content: [] }]);
			},
		],
		[
			"a compacted history",
			(fixture, messages) =>
				run(fixture, 1, {}, [{ role: "user", content: "Summary", timestamp: 1 }, ...messages.slice(-2)]),
		],
	];
	it.each(mismatches)("restarts the process on %s", async (_name, next) => {
		const fixture = await setup();
		const { messages } = await run(fixture, 3);
		await next(fixture, messages);
		const pids = fixture.pids();
		expect(pids).toHaveLength(3);
		expect(await settled([pids[1] ?? 0])).toBe(true);
	});

	it("keeps a history with an image on one process per request", async () => {
		const fixture = await setup();
		await run(fixture, 3, {}, [
			{
				role: "user",
				content: [
					{ type: "text", text: "Read files" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				timestamp: 0,
			},
		]);
		expect(fixture.pids()).toHaveLength(3);
		expect(await settled(fixture.pids())).toBe(true);
	});

	it("restarts the process on a model switch", async () => {
		const fixture = await setup();
		const { messages } = await run(fixture, 3);
		const result = await streamClaudeCode(
			ANTHROPIC_MODELS["claude-sonnet-5-5"],
			{ systemPrompt: "You are lunR.", messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId: "session-a" },
			true,
			fixture.upstream,
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(fixture.pids()).toHaveLength(3);
		expect(await settled([fixture.pids()[1] ?? 0])).toBe(true);
	});

	it("restarts the process after an upstream error", async () => {
		const fixture = await setup((n) => (n === 3 ? 500 : `file-${n}`));
		const { messages } = await run(fixture, 2);
		const failed = await streamClaudeCode(
			ANTHROPIC_MODELS["claude-opus-4-8"],
			{ systemPrompt: "You are lunR.", messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId: "session-a" },
			true,
			fixture.upstream,
		).result();
		expect(failed.stopReason).toBe("error");
		await run(fixture, 1, {}, messages);
		expect(fixture.pids()).toHaveLength(3);
	});

	it("ends the live process when the session ends and after an abort", async () => {
		const fixture = await setup();
		await run(fixture, 2);
		const [, live] = fixture.pids();
		cleanupSessionResources("session-a");
		expect(await settled([live ?? 0])).toBe(true);

		await run(fixture, 2, {}, [{ role: "user", content: "Switch", timestamp: 0 }]);
		cleanupConversationResources("session-a");
		expect(await settled(fixture.pids())).toBe(true);

		const { messages } = await run(fixture, 2, {}, [{ role: "user", content: "Again", timestamp: 0 }]);
		const controller = new AbortController();
		const stream = streamClaudeCode(
			ANTHROPIC_MODELS["claude-opus-4-8"],
			{ systemPrompt: "You are lunR.", messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId: "session-a", signal: controller.signal },
			true,
			fixture.upstream,
		);
		for await (const event of stream) if (event.type === "start") controller.abort();
		expect(await settled(fixture.pids())).toBe(true);
	});

	it("sends a history with text after a tool call one-shot, block for block as lunR has it", async () => {
		const fixture = await setup((n) => (n === 2 ? "file-2|after" : `file-${n}`));
		const { messages } = await run(fixture, 5);
		// Requests 3 to 5 carry the turn the fake (like Claude Code) would reorder.
		for (const index of [2, 3, 4])
			expect(upstreamHistory(fixture.bodies[index]?.messages ?? [])).toEqual(
				lunrHistory(messages.slice(0, 2 * index + 1)),
			);
		expect(await settled(fixture.sessionPids())).toBe(true);
	});

	it("sends a request one-shot when Claude Code changed its copy before answering", async () => {
		const fixture = await setup((n) => (n === 2 ? "COMPACT" : `file-${n}`));
		await run(fixture, 4);
		const [first] = fixture.sessionPids();
		expect(await settled([first ?? 0])).toBe(true);
		expect(fixture.sessionPids().length).toBeGreaterThan(1);
	});

	it("sends a request one-shot when the live process refuses it near its context limit", async () => {
		const fixture = await setup((n) => (n === 2 ? "REFUSE" : `file-${n}`));
		const { last } = await run(fixture, 3);
		expect(last.stopReason).toBe("toolUse");
		expect(fixture.bodies).toHaveLength(3);
		const [first] = fixture.sessionPids();
		expect(await settled([first ?? 0])).toBe(true);
	});

	it("starts one live process for two requests that arrive together", async () => {
		const fixture = await setup(() => undefined);
		const resumed: Message[] = [
			{ role: "user", content: "c1", timestamp: 0 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-8",
				content: [{ type: "text", text: "a1" }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "c2", timestamp: 2 },
		];
		const request = () =>
			streamClaudeCode(
				ANTHROPIC_MODELS["claude-opus-4-8"],
				{ systemPrompt: "You are lunR.", messages: [...resumed], tools },
				{ externalClaudeCode: fixture.connection, sessionId: "session-a" },
				true,
				fixture.upstream,
			).result();
		const answers = await Promise.all([request(), request()]);
		expect(answers.map((answer) => answer.errorMessage)).toEqual([undefined, undefined]);
		expect(fixture.sessionPids()).toHaveLength(1);
		cleanupSessionResources("session-a");
		expect(await settled(fixture.pids())).toBe(true);
	});

	it("keeps at most three live processes and stops the least recently used", async () => {
		const fixture = await setup();
		for (const sessionId of ["s1", "s2", "s3", "s4"]) await run(fixture, 2, { sessionId });
		const [oldest, ...others] = fixture.sessionPids();
		expect(await settled([oldest ?? 0])).toBe(true);
		expect(others.filter(alive)).toHaveLength(3);
	});

	it("holds a tool call Claude Code makes before the answer ends", async () => {
		const fixture = await setup(undefined, { gap: 200 });
		await run(fixture, 4);
		expect(fixture.bodies).toHaveLength(4);
		expect(fixture.sessionPids()).toHaveLength(1);
	});

	it("answers parallel tool calls Claude Code makes in the other order", async () => {
		const fixture = await setup((n) => (n === 2 ? "a+b" : `file-${n}`), {
			gap: 200,
			result: (path) => ({ text: path === "file-1" ? "REVERSE" : `contents of ${path}` }),
		});
		const { messages } = await run(fixture, 4);
		expect(fixture.bodies).toHaveLength(4);
		expect(fixture.sessionPids()).toHaveLength(1);
		expect(upstreamHistory(fixture.bodies[2]?.messages ?? [])).toEqual(lunrHistory(messages.slice(0, 6)));
	});

	it("stops the process, and nothing more is sent, when lunR aborts after a tool block", async () => {
		const fixture = await setup(undefined, { gap: 300 });
		const { messages } = await run(fixture, 2);
		const controller = new AbortController();
		const stream = streamClaudeCode(
			ANTHROPIC_MODELS["claude-opus-4-8"],
			{ systemPrompt: "You are lunR.", messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId: "session-a", signal: controller.signal },
			true,
			fixture.upstream,
		);
		for await (const event of stream) if (event.type === "toolcall_end") controller.abort();
		const sent = fixture.bodies.length;
		expect(await settled(fixture.pids())).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(fixture.bodies).toHaveLength(sent);
	});

	it("sends tool results Claude Code would rewrite one-shot, as lunR has them", async () => {
		const results: Record<string, { text: string; isError?: boolean }> = {
			"file-2": { text: " \n" },
			"file-3": { text: "E".repeat(20_000), isError: true },
			"file-4": { text: "failed\n", isError: true },
		};
		const fixture = await setup(undefined, { result: (path) => results[path] ?? { text: `contents of ${path}` } });
		const { messages } = await run(fixture, 6);
		// One upstream request per lunR request: none went out with a rewritten result first.
		expect(fixture.bodies).toHaveLength(6);
		for (const index of [2, 3, 4, 5])
			expect(upstreamHistory(fixture.bodies[index]?.messages ?? [])).toEqual(
				lunrHistory(messages.slice(0, 2 * index + 1)),
			);
		expect(await settled(fixture.sessionPids())).toBe(true);
	});

	it.each(["STATUS_LINE", "HOOKLINE"])(
		"sends a request one-shot when Claude Code prints a %s line",
		async (marker) => {
			const fixture = await setup(undefined, {
				result: (path) => ({ text: path === "file-2" ? marker : `contents of ${path}` }),
			});
			await run(fixture, 4);
			const [first] = fixture.sessionPids();
			expect(await settled([first ?? 0])).toBe(true);
		},
	);

	it("checks what Claude Code prints after an end_turn answer before the next turn", async () => {
		const fixture = await setup((n) => (n === 3 ? undefined : `file-${n}`), {
			result: (path) => ({ text: path === "file-2" ? "TAILNOTE" : `contents of ${path}` }),
		});
		const { messages } = await run(fixture, 3);
		messages.push({ role: "user", content: "Again", timestamp: 9 });
		const sent = [...messages];
		await run(fixture, 1, {}, messages);
		const [first] = fixture.sessionPids();
		expect(await settled([first ?? 0])).toBe(true);
		expect(upstreamHistory(fixture.bodies.at(-1)?.messages ?? [])).toEqual(lunrHistory(sent));
	});
});

/** lunR's history in the Messages shape the bridge receives, consecutive user turns merged. */
function lunrHistory(messages: readonly Message[]): { role: string; content: unknown[] }[] {
	const out: { role: string; content: unknown[] }[] = [];
	for (const message of messages) {
		const role = message.role === "assistant" ? "assistant" : "user";
		const content: unknown[] =
			message.role === "user"
				? typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: message.content
				: message.role === "assistant"
					? message.content.map((block) =>
							block.type === "toolCall"
								? { type: "tool_use", id: block.id, name: `mcp__lunr__${block.name}`, input: block.arguments }
								: block.type === "text"
									? { type: "text", text: block.text }
									: block,
						)
					: [
							{
								type: "tool_result",
								tool_use_id: message.toolCallId,
								content: message.content.map((block) =>
									block.type === "text" ? { type: "text", text: block.text } : block,
								),
								...(message.isError ? { is_error: true } : {}),
							},
						];
		const previous = out.at(-1);
		if (role === "user" && previous?.role === "user") previous.content.push(...content);
		else out.push({ role, content });
	}
	return out;
}

/** An upstream request's history without Claude Code's notes, cache markers and default fields. */
function upstreamHistory(
	messages: readonly { role: string; content: unknown }[],
): { role: string; content: unknown[] }[] {
	const out: { role: string; content: unknown[] }[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		const content = (Array.isArray(blocks) ? blocks : []).map((block) => {
			const { cache_control: _marker, caller: _caller, ...rest } = block as Record<string, unknown>;
			if (rest.type !== "tool_result") return rest;
			const { is_error, ...result } = rest;
			return {
				...result,
				content: typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content,
				...(is_error ? { is_error } : {}),
			};
		});
		const previous = out.at(-1);
		if (message.role === "user" && previous?.role === "user") previous.content.push(...content);
		else out.push({ role: message.role, content });
	}
	return out;
}
