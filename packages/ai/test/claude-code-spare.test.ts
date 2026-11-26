import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { streamClaudeCode } from "../src/api/anthropic-claude-code-bridge.ts";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { cleanupConversationResources, cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Context, Message } from "../src/types.ts";

/**
 * Stand-in for Claude Code 2.1.310 on the one-request route: the body comes from `--settings`, or from an
 * `apply_flag_settings` control request, which it confirms with a `control_response` (unless its directory
 * ends in "deaf", which ignores it, or "refuses", which answers with an error; "slow-once" answers the first
 * control request of the fixture after 3 s; "dies" exits without output when the query frame arrives after
 * a confirmed body). When stdin ends it sends one request with that body and prints each SSE event as a
 * `stream_event` line. Each process appends its pid to `started` when it starts, and
 * `{ pid, fileBody, appliedBody }` to `spawns` when it sends.
 */
const FAKE_CLAUDE_CODE = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
appendFileSync(join(__dirname, "started"), process.pid + "\\n");
const fileBody = (JSON.parse(readFileSync(flag("--settings"), "utf8")).env ?? {}).CLAUDE_CODE_EXTRA_BODY;
let body = fileBody;
let appliedBody = false;
const frames = [];
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\\n"); index >= 0; index = buffer.indexOf("\\n")) {
		const message = JSON.parse(buffer.slice(0, index));
		buffer = buffer.slice(index + 1);
		if (message.type !== "control_request") {
			if (__dirname.endsWith("dies") && appliedBody) process.exit(1);
			frames.push(message);
		} else if (__dirname.endsWith("refuses")) line({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "unsupported" } });
		else if (!__dirname.endsWith("deaf") && message.request.subtype === "apply_flag_settings") {
			body = message.request.settings.env.CLAUDE_CODE_EXTRA_BODY;
			appliedBody = true;
			const reply = () => line({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
			const slow = __dirname.endsWith("slow-once") && !existsSync(join(__dirname, "slowed"));
			if (slow) writeFileSync(join(__dirname, "slowed"), "");
			if (slow) setTimeout(reply, 3000);
			else reply();
		}
	}
});
process.stdin.on("end", async () => {
	appendFileSync(join(__dirname, "spawns"), JSON.stringify({ pid: process.pid, fileBody: !!fileBody, appliedBody }) + "\\n");
	const request = { model: flag("--model"), messages: frames.map((frame) => frame.message), ...JSON.parse(body ?? "{}"), stream: true };
	const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify(request) });
	for (const event of (await response.text()).split("\\n\\n")) {
		const data = event.split("\\n").find((row) => row.startsWith("data: "));
		if (data) line({ type: "stream_event", event: JSON.parse(data.slice(6)) });
	}
	line({ type: "result", is_error: false, num_turns: 1 });
});
`;

const sse = (...events: object[]) =>
	events.map((event) => `event: ${"type" in event ? event.type : ""}\ndata: ${JSON.stringify(event)}\n\n`).join("");

/** A `read` call for `file-<n>`, or text ending the turn when `toolCall` is false. */
function answer(n: number, toolCall: boolean): string {
	const block = toolCall
		? { type: "tool_use", id: `toolu_${n}`, name: "mcp__lunr__read", input: {} }
		: { type: "text", text: "" };
	const delta = toolCall
		? { type: "input_json_delta", partial_json: JSON.stringify({ path: `file-${n}` }) }
		: { type: "text_delta", text: "done" };
	return sse(
		{
			type: "message_start",
			message: {
				id: `msg_${n}`,
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
			delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
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

/** A recording upstream that answers with a tool call until request `turns`, and a fake Claude Code named `name`. */
async function setup(turns: number, name = "claude-code") {
	const root = mkdtempSync(join(tmpdir(), "lunr-claude-spare-"));
	directories.push(root);
	const directory = join(root, name);
	mkdirSync(directory);
	const command = join(directory, "claude");
	writeFileSync(command, FAKE_CLAUDE_CODE);
	chmodSync(command, 0o755);
	const bodies: { system?: unknown; messages: unknown[] }[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(answer(bodies.length, bodies.length < turns));
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
		models: [{ id: "claude-opus-4-8", route: "claude-opus-4-8" }],
	};
	const rows = (file: string) => {
		try {
			return readFileSync(join(directory, file), "utf8").split("\n").filter(Boolean);
		} catch {
			return [];
		}
	};
	const spawns = (): { pid: number; fileBody: boolean; appliedBody: boolean }[] =>
		rows("spawns").map((row) => JSON.parse(row));
	const started = () => rows("started").map(Number);
	return {
		connection,
		upstream: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
		bodies,
		spawns,
		started,
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;

const tools: NonNullable<Context["tools"]> = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

/** Pids of fake Claude Code processes that are still running. */
function running(fixture: Fixture): number[] {
	return fixture.started().flatMap((pid) => {
		try {
			process.kill(pid, 0);
			return [pid];
		} catch {
			return [];
		}
	});
}

/** Waits briefly for `check` to hold, for processes that are being stopped. */
async function settled(check: () => boolean): Promise<boolean> {
	// Generous, since a loaded machine can take seconds to start or stop a process.
	for (let attempt = 0; attempt < 500 && !check(); attempt++) await new Promise((r) => setTimeout(r, 20));
	return check();
}

/** Runs lunR's agent loop for `turns` requests of one session; each tool call gets a text result. */
async function run(
	fixture: Fixture,
	turns: number,
	{ sessionId = "session-a", systemPrompt = "You are lunR.", messages = [] as Message[] } = {},
): Promise<{ messages: Message[]; last: AssistantMessage }> {
	if (!messages.length) messages.push({ role: "user", content: "Read files", timestamp: 0 });
	let last: AssistantMessage | undefined;
	for (let turn = 0; turn < turns; turn++) {
		last = await streamClaudeCode(
			ANTHROPIC_MODELS["claude-opus-4-8"],
			{ systemPrompt, messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId },
			true,
			fixture.upstream,
		).result();
		expect(last.errorMessage).toBeUndefined();
		messages.push(last);
		const call = last.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") break;
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

describe.skipIf(process.platform === "win32")("Claude Code spare processes", () => {
	it("runs each request after a tool call on a spare that gets the exact body through the control request", async () => {
		const fixture = await setup(3);
		const { messages } = await run(fixture, 3);
		// One cold process, then a spare for each request after a tool call; none received a body at start.
		expect(fixture.spawns().map(({ fileBody, appliedBody }) => ({ fileBody, appliedBody }))).toEqual([
			{ fileBody: true, appliedBody: false },
			{ fileBody: false, appliedBody: true },
			{ fileBody: false, appliedBody: true },
		]);
		// The same history sent cold carries the same messages.
		const cold = await setup(1);
		await run(cold, 1, { sessionId: "", messages: messages.slice(0, 5) });
		expect(fixture.bodies[2]?.messages).toEqual(cold.bodies[0]?.messages);
		expect(fixture.bodies).toHaveLength(3);
	});

	it.each(["deaf", "refuses"])("runs cold when a %s spare does not confirm the body", async (name) => {
		const fixture = await setup(2, name);
		await run(fixture, 2);
		// The spare was started and stopped without a query, so no request left with a stale or empty body:
		// both requests came from processes that read their body from --settings.
		expect(fixture.started()).toHaveLength(3);
		expect(fixture.spawns().map(({ fileBody, appliedBody }) => ({ fileBody, appliedBody }))).toEqual([
			{ fileBody: true, appliedBody: false },
			{ fileBody: true, appliedBody: false },
		]);
		expect(fixture.bodies).toHaveLength(2);
		expect(JSON.stringify(fixture.bodies[1]?.messages)).toContain("contents of file-1");
	});

	it("stops the spare and runs cold when the request no longer fits it", async () => {
		const fixture = await setup(2);
		const { messages } = await run(fixture, 1);
		expect(await settled(() => fixture.started().length === 2)).toBe(true);
		await run(fixture, 1, { systemPrompt: "Changed.", messages });
		// Cold, the spare (stopped unused), cold again.
		expect(fixture.started()).toHaveLength(3);
		expect(fixture.spawns().map(({ fileBody }) => fileBody)).toEqual([true, true]);
		expect(await settled(() => running(fixture).length === 0)).toBe(true);
	});

	it("keeps a session's spare for that session only", async () => {
		const fixture = await setup(2);
		const { messages } = await run(fixture, 1);
		expect(await settled(() => fixture.started().length === 2)).toBe(true);
		await run(fixture, 1, { sessionId: "session-b", messages });
		expect(fixture.spawns().map(({ fileBody }) => fileBody)).toEqual([true, true]);
		// Session a's spare still waits for session a.
		const spare = fixture.started()[1] ?? 0;
		expect(await settled(() => running(fixture).join() === String(spare))).toBe(true);
	});

	it.each([
		["the session ends", () => cleanupSessionResources("session-a")],
		["a run is aborted", () => cleanupConversationResources("session-a")],
	])("stops the spare when %s", async (_name, stop) => {
		const fixture = await setup(2);
		await run(fixture, 1);
		expect(await settled(() => fixture.started().length === 2)).toBe(true);
		// The cold process has ended; the spare started at the tool call is the one still running.
		const spare = fixture.started()[1] ?? 0;
		expect(await settled(() => running(fixture).join() === String(spare))).toBe(true);
		stop();
		expect(await settled(() => running(fixture).length === 0)).toBe(true);
	});

	it("runs one request cold after a late confirmation and keeps using spares", async () => {
		const fixture = await setup(4, "slow-once");
		await run(fixture, 3);
		// Cold; the late spare's request ran cold; the next request ran on a spare again.
		expect(fixture.spawns().map(({ appliedBody }) => appliedBody)).toEqual([false, false, true]);
		expect(fixture.bodies).toHaveLength(3);
	});

	it("does not count an abort during the confirmation against spares", async () => {
		const fixture = await setup(5, "slow-once");
		const { messages } = await run(fixture, 1);
		expect(await settled(() => fixture.started().length === 2)).toBe(true);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const aborted = await streamClaudeCode(
			ANTHROPIC_MODELS["claude-opus-4-8"],
			{ systemPrompt: "You are lunR.", messages, tools },
			{ externalClaudeCode: fixture.connection, sessionId: "session-a", signal: controller.signal },
			true,
			fixture.upstream,
		).result();
		expect(aborted.stopReason).toBe("aborted");
		await run(fixture, 2, { messages: [{ role: "user", content: "Again", timestamp: 1 }] });
		expect(fixture.spawns().map(({ appliedBody }) => appliedBody)).toEqual([false, false, true]);
	});

	it("reruns a request cold when its spare dies after confirming the body", async () => {
		const fixture = await setup(2, "dies");
		const { last } = await run(fixture, 2);
		expect(last.stopReason).toBe("stop");
		expect(fixture.spawns().map(({ fileBody }) => fileBody)).toEqual([true, true]);
		expect(fixture.bodies).toHaveLength(2);
	});

	it.each(["exit", "kill"])(
		"leaves no process directory behind after lunR's %s",
		async (how) => {
			// Every answer is a tool call, so each lunR keeps a spare.
			const fixture = await setup(100);
			const temp = mkdtempSync(join(tmpdir(), "lunr-spare-tmp-"));
			directories.push(temp);
			const bridge = pathToFileURL(join(import.meta.dirname, "../src/api/anthropic-claude-code-bridge.ts")).href;
			const models = pathToFileURL(join(import.meta.dirname, "../src/providers/anthropic.models.ts")).href;
			// One tool turn of a session, which leaves a spare waiting; then exit, or wait to be killed.
			// Waits until `processes` fake Claude Code processes have started, so this lunR's spare exists.
			const script = (end: string, processes = 2) => `
			const { streamClaudeCode } = await import(${JSON.stringify(bridge)});
			const { ANTHROPIC_MODELS } = await import(${JSON.stringify(models)});
			const tools = ${JSON.stringify(tools)};
			await streamClaudeCode(ANTHROPIC_MODELS["claude-opus-4-8"], { systemPrompt: "x", messages: [{ role: "user", content: "hi", timestamp: 1 }], tools },
				{ externalClaudeCode: ${JSON.stringify(fixture.connection)}, sessionId: "s" }, true, ${JSON.stringify(fixture.upstream)}).result();
			const { readFileSync } = await import("node:fs");
			while (readFileSync(${JSON.stringify(join(fixture.connection.command, "../started"))}, "utf8").trim().split("\\n").length < ${processes}) await new Promise((r) => setTimeout(r, 20));
			${end}`;
			const env = { ...process.env, TMPDIR: temp };
			const lunrDirectories = () => readdirSync(temp).filter((name) => name.startsWith("lunr-claude-code-"));
			// Asynchronous, so this process keeps serving the fixture upstream meanwhile.
			const start = (end: string, processes?: number) =>
				spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script(end, processes)], {
					env,
					stdio: ["ignore", "pipe", "inherit"],
				});
			const closed = (child: ReturnType<typeof start>) =>
				new Promise<number | null>((resolve) => child.once("close", resolve));
			if (how === "exit") {
				expect(await closed(start("process.exit(0);"))).toBe(0);
			} else {
				const child = start("console.log('ready'); setInterval(() => {}, 1000);");
				await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
				expect(lunrDirectories()).toHaveLength(1);
				child.kill("SIGKILL");
				await closed(child);
				// The next lunR's first Claude Code start sweeps what the killed one left, in the background.
				const swept = `const { readdirSync } = await import("node:fs");
					const others = () => readdirSync(process.env.TMPDIR).filter((name) => name.startsWith("lunr-claude-code-") && !name.startsWith("lunr-claude-code-" + process.pid + "-"));
					for (let i = 0; i < 250 && others().length; i++) await new Promise((r) => setTimeout(r, 20));
					process.exit(0);`;
				// Its own cold process and spare are the third and fourth.
				expect(await closed(start(swept, 4))).toBe(0);
			}
			expect(lunrDirectories()).toEqual([]);
		},
		60_000,
	);
});
