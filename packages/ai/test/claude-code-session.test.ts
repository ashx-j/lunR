import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { streamClaudeCode } from "../src/api/anthropic-claude-code-bridge.ts";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { cleanupModelSwitchResources, cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Context, Message, StreamOptions } from "../src/types.ts";

/**
 * Stand-in for a long-lived Claude Code 2.1.310 in stream-json mode, matching what the real binary did
 * against a fixture upstream: it keeps its own history from the frames it reads, queries on every frame
 * without `shouldQuery: false`, runs tool calls through the MCP endpoint with the tool use id in `_meta`,
 * and keeps querying until an answer ends its turn. Fields from CLAUDE_CODE_EXTRA_BODY replace its own,
 * so a one-shot process (with `messages` there) sends the body's history. Each process appends its pid
 * to `pids` next to itself.
 */
const FAKE_CLAUDE_CODE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
appendFileSync(join(__dirname, "pids"), process.pid + "\\n");
const extra = JSON.parse(JSON.parse(readFileSync(flag("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
const mcpUrl = JSON.parse(readFileSync(flag("--mcp-config"), "utf8")).mcpServers.lunr.url;
const oneShot = argv.includes("--max-turns");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const history = [];
let queue = Promise.resolve();
async function query() {
	line({ type: "system", subtype: "init" });
	for (;;) {
		const body = { model: flag("--model"), messages: history, ...extra, stream: true };
		const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify(body) });
		const text = await response.text();
		if (response.status !== 200) {
			line({ type: "result", is_error: true, num_turns: 1, api_error_status: response.status, result: "API Error" });
			return;
		}
		const content = [];
		let stop;
		for (const chunk of text.split("\\n\\n")) {
			const data = chunk.split("\\n").find((row) => row.startsWith("data: "));
			if (!data) continue;
			const event = JSON.parse(data.slice(6));
			line({ type: "stream_event", event });
			if (event.type === "content_block_start") content[event.index] = { ...event.content_block };
			if (event.type === "content_block_delta" && event.delta.type === "text_delta") content[event.index].text += event.delta.text;
			if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") content[event.index].input = JSON.parse(event.delta.partial_json);
			if (event.type === "message_delta") stop = event.delta.stop_reason;
		}
		history.push({ role: "assistant", content: content.map(({ caller, ...block }) => block) });
		if (stop !== "tool_use" || oneShot) {
			line({ type: "result", is_error: false, num_turns: 1 });
			return;
		}
		const results = [];
		for (const call of content.filter((block) => block.type === "tool_use")) {
			const reply = await fetch(mcpUrl, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.input, _meta: { "claudecode/toolUseId": call.id } } }) });
			const data = (await reply.text()).split("\\n").find((row) => row.startsWith("data: "));
			const { result } = JSON.parse(data.slice(6));
			results.push(result.isError ? { type: "tool_result", tool_use_id: call.id, content: result.content[0].text, is_error: true } : { type: "tool_result", tool_use_id: call.id, content: result.content });
		}
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

/** An upstream answer: a `read` tool call for `path`, or text that ends the turn. */
function answer(index: number, path?: string): string {
	const block = path
		? { type: "tool_use", id: `toolu_${index}`, name: "mcp__lunr__read", input: {}, caller: { type: "direct" } }
		: { type: "text", text: "" };
	const delta = path
		? { type: "input_json_delta", partial_json: JSON.stringify({ path }) }
		: { type: "text_delta", text: "done" };
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
		{ type: "content_block_start", index: 0, content_block: block },
		{ type: "content_block_delta", index: 0, delta },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: path ? "tool_use" : "end_turn", stop_sequence: null },
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
 * answer, or an HTTP status to fail with.
 */
async function setup(script: (request: number) => string | number | undefined = (n) => `file-${n}`) {
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
			res.end(answer(bodies.length, step));
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
	const pids = () => readFileSync(join(directory, "pids"), "utf8").split("\n").filter(Boolean).map(Number);
	return { connection, upstream, bodies, pids };
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
			const call = last.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") break;
			messages.push({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `contents of ${String(call.arguments.path)}` }],
				isError: false,
				timestamp: turn,
			});
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
		cleanupModelSwitchResources("session-a");
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
});
