import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
const root = await mkdtemp(join(tmpdir(), "lunr-hosted-"));
const profile = join(root, "profile");
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
await Promise.all([mkdir(profile), mkdir(cwd), mkdir(sessionDir)]);
let calls = 0;
let mcpCalls = 0;
const server = createServer(async (req, res) => {
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	let body = "";
	for await (const b of req) body += b;
	const input = JSON.parse(body);
	if (req.url === "/mcp") {
		assert.equal(req.headers.authorization, "Bearer fixture-only");
		if (input.id === undefined) {
			res.writeHead(202);
			res.end();
			return;
		}
		const result =
			input.method === "initialize"
				? {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture-host", version: "1" },
					}
				: input.method === "tools/list"
					? {
							tools: [
								{
									name: "host_ping",
									description: "Test thread host access",
									inputSchema: { type: "object", properties: {} },
								},
							],
						}
					: input.method === "tools/call"
						? { content: [{ type: "text", text: "Host fixture works" }] }
						: {};
		if (input.method === "tools/call") mcpCalls++;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
		return;
	}
	calls++;
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	const emit = (delta, finish_reason = null) =>
		res.write(
			`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
	const lastUser = input.messages.findLastIndex((m) => m.role === "user");
	const userText = JSON.stringify(input.messages[lastUser]?.content);
	const toolCount = input.messages.slice(lastUser).filter((m) => m.role === "tool").length;
	if (userText.includes("Plan approval fixture")) {
		if (toolCount === 0) {
			emit({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "plan-1",
						type: "function",
						function: {
							name: "present_plan",
							arguments: JSON.stringify({ summary: "Write one approved plan file." }),
						},
					},
				],
			});
			emit({}, "tool_calls");
		} else if (toolCount === 1) {
			emit({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "plan-write",
						type: "function",
						function: {
							name: "write",
							arguments: JSON.stringify({ path: "plan-approved.txt", content: "approved plan" }),
						},
					},
				],
			});
			emit({}, "tool_calls");
		} else {
			emit({ role: "assistant", content: "Plan implemented" });
			emit({}, "stop");
		}
		res.end("data: [DONE]\n\n");
		return;
	}
	if (userText.includes("Helper fixture")) {
		assert(!input.tools?.length);
		emit({ role: "assistant", content: '{"title":"Fixture title"}' });
		emit({}, "stop");
		res.end("data: [DONE]\n\n");
		return;
	}
	if (userText.includes("Image fixture")) {
		assert(input.messages[lastUser].content.some((p) => p.type === "image_url"));
		emit({ role: "assistant", content: "Image received" });
		emit({}, "stop");
		res.end("data: [DONE]\n\n");
		return;
	}
	if (userText.includes("Background task completed")) {
		emit({ role: "assistant", content: "Child result received" });
		emit({}, "stop");
		res.end("data: [DONE]\n\n");
		return;
	}
	if (userText.includes("hold fixture")) {
		emit({ role: "assistant", content: "Waiting" });
		return;
	}
	if (userText.includes("Only child fixture") || userText.includes("Host access fixture")) {
		if (toolCount === 0) {
			emit({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "mcp-1",
						type: "function",
						function: {
							name: "mcp",
							arguments: JSON.stringify({ tool: "t3_code_host_ping", server: "t3-code", args: "{}" }),
						},
					},
				],
			});
			emit({}, "tool_calls");
		} else {
			emit({ role: "assistant", content: "Child finished" });
			emit({}, "stop");
		}
		res.end("data: [DONE]\n\n");
		return;
	}
	if (userText.includes("Start async fixture") || userText.includes("Stop async fixture")) {
		if (toolCount === 0) {
			emit({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "child-1",
						type: "function",
						function: {
							name: "subagent",
							arguments: JSON.stringify({
								task: userText.includes("Stop async fixture")
									? "hold fixture child"
									: "Only child fixture: respond briefly",
								description: "Fixture child",
								model: "fixture/fixture",
								async: true,
							}),
						},
					},
				],
			});
			emit({}, "tool_calls");
		} else {
			emit({ role: "assistant", content: "Parent settled" });
			emit({}, "stop");
		}
		res.end("data: [DONE]\n\n");
		return;
	}
	if (toolCount === 0) {
		emit({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "read-1",
					type: "function",
					function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) },
				},
			],
		});
		emit({}, "tool_calls");
	} else if (toolCount === 1) {
		emit({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "write-1",
					type: "function",
					function: {
						name: "write",
						arguments: JSON.stringify({ path: "approved.txt", content: "approved once" }),
					},
				},
			],
		});
		emit({}, "tool_calls");
	} else if (toolCount === 2) {
		emit({
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "write-2",
					type: "function",
					function: {
						name: "write",
						arguments: JSON.stringify({ path: "denied.txt", content: "must not exist" }),
					},
				},
			],
		});
		emit({}, "tool_calls");
	} else {
		emit({ role: "assistant", content: "Hello 🌙" });
		emit({}, "stop");
	}
	res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
await writeFile(join(cwd, "input.txt"), "fixture");
await writeFile(
	join(profile, "models.json"),
	JSON.stringify({
		providers: {
			fixture: {
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				api: "openai-completions",
				apiKey: "fixture",
				models: [
					{ id: "fixture", contextWindow: 32768, maxTokens: 1000, reasoning: false, input: ["text", "image"] },
				],
			},
		},
	}),
);
await writeFile(
	join(profile, "settings.json"),
	JSON.stringify({
		defaultProvider: "fixture",
		defaultModel: "fixture",
		sessionRetentionDays: 0,
		browserEnabled: false,
	}),
);
const cli = resolve(process.env.LUNR_TEST_CLI ?? "packages/coding-agent/dist/cli.js");
function worker() {
	const child = spawn(process.execPath, [cli, "--mode", "rpc", "--hosted", "--offline"], {
		cwd,
		env: { ...process.env, PI_CODING_AGENT_DIR: profile, HOME: root, USERPROFILE: root },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let buffer = "",
		err = "";
	const events = [];
	const waiters = [];
	child.stderr.on("data", (b) => (err += b));
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const at = buffer.indexOf("\n");
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			const event = JSON.parse(line);
			events.push(event);
			for (const w of [...waiters])
				if (w.p(event)) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(event);
				}
		}
	});
	const wait = (p) =>
		new Promise((resolve, reject) => {
			const found = events.find(p);
			if (found) return resolve(found);
			const timer = setTimeout(
				() => reject(Error("Timed out " + err + "\n" + JSON.stringify(events.slice(-8)))),
				20000,
			);
			waiters.push({
				p,
				resolve: (e) => {
					clearTimeout(timer);
					resolve(e);
				},
			});
		});
	const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
	return { child, events, wait, send };
}
await mkdir(join(cwd, ".lunr", "extensions"), { recursive: true });
await writeFile(
	join(cwd, ".lunr", "extensions", "trap.ts"),
	`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, "project-loaded"))}, 'unexpected'); export default function() {}`,
);
let w = worker();
w.send({ id: "bad", type: "host_initialize", version: 99, intent: "discovery" });
await w.wait((e) => e.command === "host_initialize" && e.success === false);
await once(w.child, "exit");
w = worker();
w.send({ id: "discover", type: "host_initialize", version: 1, intent: "discovery" });
let r = await w.wait((e) => e.id === "discover");
assert.equal(r.success, true);
assert(r.data.models.some((m) => m.provider === "fixture"));
await once(w.child, "exit");
assert.equal(calls, 0);
await assert.rejects(readFile(join(root, "project-loaded")));
w = worker();
w.send({
	id: "init",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	projectTrusted: false,
	policy: "approval-required",
	provider: "fixture",
	modelId: "fixture",
});
r = await w.wait((e) => e.id === "init");
assert.equal(r.success, true);
const sessionFile = r.data.sessionFile;
w.send({ id: "turn-1", type: "prompt", message: "Do the scripted fixture" });
let a = await w.wait((e) => e.type === "host_approval_request");
assert.equal(a.toolName, "write");
w.send({ id: "yes", type: "host_approval_response", requestId: a.requestId, decision: "once" });
a = await w.wait((e) => e.type === "host_approval_request" && e.requestId !== a.requestId);
w.send({
	id: "no",
	type: "host_approval_response",
	requestId: a.requestId,
	decision: "reject",
	reason: "fixture denial",
});
await w.wait((e) => e.type === "host_turn_settled");
assert.equal(await readFile(join(cwd, "approved.txt"), "utf8"), "approved once");
await assert.rejects(readFile(join(cwd, "denied.txt")));
assert(w.events.some((e) => e.type === "message_update" && e.assistantMessageEvent?.delta?.includes("Hello")));
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
w = worker();
w.send({
	id: "resume",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	sessionFile,
	projectTrusted: false,
	policy: "approval-required",
	provider: "fixture",
	modelId: "fixture",
});
r = await w.wait((e) => e.id === "resume");
assert.equal(r.success, true);
assert(r.data.boundaries.some((e) => e.data.turnId === "turn-1"));
const beforeSlash = calls;
w.send({ id: "thinking-command", type: "prompt", message: "/thinking off" });
await w.wait((e) => e.type === "host_turn_settled" && e.turnId === "thinking-command");
assert.equal(calls, beforeSlash, "Handled slash commands settle without inference");

w.send({ id: "turn-1", type: "prompt", message: "Do not replay" });
r = await w.wait((e) => e.id === "turn-1");
assert.equal(r.success, false);
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
// Cancellation while a provider stream is still open.
w = worker();
w.send({
	id: "cancel-init",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	projectTrusted: false,
	policy: "full-access",
	provider: "fixture",
	modelId: "fixture",
});
await w.wait((e) => e.id === "cancel-init");
w.send({ id: "cancel-turn", type: "prompt", message: "hold fixture" });
await w.wait((e) => e.type === "message_update");
w.send({ id: "abort", type: "abort" });
await w.wait((e) => e.id === "abort");
await w.wait((e) => e.type === "host_turn_settled");
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
// The native async child runs through the real lunR subprocess implementation.
w = worker();
w.send({
	id: "child-init",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	projectTrusted: false,
	policy: "full-access",
	provider: "fixture",
	modelId: "fixture",
	mcp: { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, authorization: "Bearer fixture-only" },
});
await w.wait((e) => e.id === "child-init");
w.send({ id: "parent-turn", type: "prompt", message: "Start async fixture" });
await w.wait((e) => e.type === "host_child_event" && e.name === "subagent:async-started");
await w.wait((e) => e.type === "host_child_event" && e.name === "subagent:async-complete");
await w.wait((e) => e.type === "host_turn_started" && e.autonomous);
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
assert(mcpCalls > 0, "Native child must reach scoped host MCP");
// Stopping one owned child settles it without waking an idle parent.
w = worker();
w.send({
	id: "stop-child-init",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	projectTrusted: false,
	policy: "full-access",
	provider: "fixture",
	modelId: "fixture",
});
await w.wait((e) => e.id === "stop-child-init");
w.send({ id: "stop-parent", type: "prompt", message: "Stop async fixture" });
const started = await w.wait((e) => e.type === "host_child_event" && e.name === "subagent:async-started");
await w.wait((e) => e.type === "host_turn_settled");
await w.wait((e) => e.type === "host_child_event" && e.name === "subagent:progress" && e.runId === started.runId);
w.send({ id: "foreign-child", type: "host_child_control", method: "stop", runId: "not-owned" });
r = await w.wait((e) => e.id === "foreign-child");
assert.equal(r.success, false);
w.send({ id: "stop-owned-child", type: "host_child_control", method: "stop", runId: started.runId });
r = await w.wait((e) => e.id === "stop-owned-child");
assert.equal(r.success, true);
assert.equal(r.data.failed, 0);
assert.equal(r.data.requested, 1);
await w.wait((e) => e.type === "host_child_event" && e.name === "subagent:async-complete");
assert(!w.events.some((e) => e.type === "host_turn_started" && e.autonomous));
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
// Plan approval restores the user's execution policy before the next tool.
w = worker();
w.send({
	id: "plan-approve-init",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd,
	sessionDir,
	projectTrusted: false,
	policy: "full-access",
	provider: "fixture",
	modelId: "fixture",
});
await w.wait((e) => e.id === "plan-approve-init");
w.send({ id: "plan-policy", type: "host_set_policy", policy: "read-only" });
await w.wait((e) => e.id === "plan-policy");
w.send({ id: "plan-approve-turn", type: "prompt", message: "Plan approval fixture" });
a = await w.wait((e) => e.type === "host_approval_request");
assert.equal(a.kind, "plan");
assert(a.detail.includes("approved plan file"));
w.send({ id: "plan-approve", type: "host_approval_response", requestId: a.requestId, decision: "once" });
await w.wait((e) => e.type === "host_turn_settled");
assert.equal(await readFile(join(cwd, "plan-approved.txt"), "utf8"), "approved plan");
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
// Hosted helpers do not load workspace code or expose tools; usage has a separate ledger.
w = worker();
w.send({
	id: "helper",
	type: "host_initialize",
	version: 1,
	intent: "text-generation",
	provider: "fixture",
	modelId: "fixture",
	prompt: "Helper fixture",
});
r = await w.wait((e) => e.id === "helper");
assert.equal(r.success, true);
assert.equal(JSON.parse(r.data.text).title, "Fixture title");
await once(w.child, "exit");
assert(
	(
		await readFile(join(profile, "sessions", "_helpers", new Date().toISOString().slice(0, 10) + ".jsonl"), "utf8")
	).includes("t3-text-generation"),
);
const planCwd = join(root, "plan");
await mkdir(planCwd);
await writeFile(join(planCwd, "input.txt"), "read only");
w = worker();
w.send({
	id: "plan",
	type: "host_initialize",
	version: 1,
	intent: "session",
	cwd: planCwd,
	sessionDir,
	projectTrusted: false,
	policy: "read-only",
	provider: "fixture",
	modelId: "fixture",
});
await w.wait((e) => e.id === "plan");
w.send({ id: "plan-turn", type: "prompt", message: "Do the scripted fixture" });
await w.wait((e) => e.type === "host_turn_settled");
await assert.rejects(readFile(join(planCwd, "approved.txt")));
await assert.rejects(readFile(join(planCwd, "denied.txt")));
assert(!w.events.some((e) => e.type === "host_approval_request"));
w.send({
	id: "image-turn",
	type: "prompt",
	message: "Image fixture",
	images: [
		{
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
		},
	],
});
await w.wait((e) => e.type === "host_turn_settled" && e.turnId === "image-turn");
w.send({ id: "stop", type: "host_shutdown" });
await once(w.child, "exit");
assert.equal(mcpCalls, 1);
await assert.rejects(readFile(join(root, "project-loaded")));
server.closeAllConnections();
server.close();
console.log(
	JSON.stringify({
		passed: true,
		calls,
		root,
		checks: [
			"discovery no inference",
			"real read",
			"approved write",
			"rejected write",
			"Unicode streaming",
			"persisted resume",
			"duplicate replay rejected",
            "headless slash settlement",
			"cancellation",
			"real async child completion",
			"idle parent wake",
			"child scoped MCP",
			"unsupported init",
			"discovery project isolation",
			"tool-free helper and ledger",
			"hard read-only policy",
			"image input",
			"owned child stop without wake",
            "native child progress",
			"plan approval restores execution policy",
		],
	}),
);
