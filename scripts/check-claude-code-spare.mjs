#!/usr/bin/env node
// Checks that a Claude Code binary still takes a request body through the `apply_flag_settings` control
// request, which lunR's spare processes depend on. Offline: a throwaway HOME with fake credentials and a
// loopback upstream; no real request is sent. Run it on every CLAUDE_CODE_VERSION bump:
//   node scripts/check-claude-code-spare.mjs <path to the pinned claude binary>
// Exits 1 when Claude Code refuses or ignores the control request, or sends a request that differs from the
// applied body in any field the spare route relies on (messages, tools, thinking, max_tokens, output_config,
// context_management) or lacks the system prompt from --system-prompt-file.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = process.argv[2];
if (!command) {
	console.error("usage: node scripts/check-claude-code-spare.mjs <path to the claude binary>");
	process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), "lunr-spare-check-"));
const fail = (message) => {
	console.error(`check-claude-code-spare: FAIL: ${message}`);
	process.exitCode = 1;
};
const nonce = randomUUID();
let received;
const answer = [
	{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");
const upstream = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (!req.url?.startsWith("/v1/messages")) return res.writeHead(404).end("{}");
		received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		res.writeHead(200, { "content-type": "text/event-stream" }).end(answer);
	});
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const home = join(root, "home");
mkdirSync(join(home, ".claude"), { recursive: true });
const credentials = { accessToken: "sk-ant-oat01-fake", refreshToken: "x", expiresAt: Date.now() + 864e5, scopes: ["user:inference", "user:profile"], subscriptionType: "max" };
writeFileSync(join(home, ".claude/.credentials.json"), JSON.stringify({ claudeAiOauth: credentials }));
const system = `You are lunR. ${nonce}`;
writeFileSync(join(root, "system.md"), system);
writeFileSync(join(root, "settings.json"), "{}");
writeFileSync(join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }));
mkdirSync(join(root, "cwd"));
const address = upstream.address();
const child = spawn(
	command,
	["-p", "--model", "claude-sonnet-5-5", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--system-prompt-file", join(root, "system.md"), "--settings", join(root, "settings.json"), "--setting-sources", "", "--strict-mcp-config", "--mcp-config", join(root, "mcp.json"), "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk", "--no-session-persistence"],
	{
		cwd: join(root, "cwd"),
		stdio: ["pipe", "pipe", "ignore"],
		detached: process.platform !== "win32",
		env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0" },
	},
);
const lines = [];
let buffer = "";
let notify = () => {};
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
		try {
			lines.push(JSON.parse(buffer.slice(0, end)));
		} catch {}
		buffer = buffer.slice(end + 1);
		notify();
	}
});
const waitFor = (test, ms) =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		notify = () => {
			const found = lines.find(test);
			if (found) {
				clearTimeout(timer);
				resolve(found);
			}
		};
	});
// The fields the spare route sends in the body, shaped like the bridge builds them.
const applied = {
	messages: [
		{ role: "user", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "answer" }] },
		{ role: "user", content: [{ type: "text", text: `body ${nonce}`, cache_control: { type: "ephemeral", ttl: "1h" } }] },
	],
	tools: [{ name: "mcp__lunr__read", description: `Read ${nonce}`, input_schema: { type: "object", properties: { path: { type: "string" } } } }],
	thinking: { type: "adaptive" },
	output_config: { effort: "high" },
	context_management: { edits: [] },
	max_tokens: 4321,
};
// A spare often gets its body while it is still starting.
await new Promise((resolve) => setTimeout(resolve, 300));
const body = JSON.stringify(applied);
child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "check", request: { subtype: "apply_flag_settings", settings: { env: { CLAUDE_CODE_EXTRA_BODY: body } } } })}\n`);
const reply = await waitFor((line) => line.type === "control_response" && line.response?.request_id === "check", 5000);
if (reply?.response?.subtype !== "success") fail(`apply_flag_settings was not confirmed: ${JSON.stringify(reply?.response ?? "no response in 5 s")}`);
else {
	child.stdin.write(`${JSON.stringify({ type: "user", client_composed: true, message: { role: "user", content: [{ type: "text", text: "first" }] } })}\n`);
	child.stdin.end();
	await waitFor((line) => line.type === "result", 15000);
	if (!received) fail("Claude Code sent no request after the control request");
	else {
		const differ = Object.keys(applied).filter((key) => JSON.stringify(received[key]) !== JSON.stringify(applied[key]));
		if (!JSON.stringify(received.system ?? "").includes(nonce)) differ.push("system");
		if (differ.length) fail(`the request differs from the applied body in: ${differ.join(", ")}`);
		else console.log("check-claude-code-spare: ok, every applied field was sent unchanged");
	}
}
try {
	if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
} catch {}
upstream.close();
rmSync(root, { recursive: true, force: true });
