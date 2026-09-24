import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCandidate } from "./remote-pty-probe-install.mjs";

const directory = await mkdtemp(join(tmpdir(), "lunr-pty-interactions-"));
const root = fileURLToPath(new URL("..", import.meta.url));
const install = join(directory, "install");
const home = join(directory, "home");
const agentDir = join(home, ".lunr", "agent");
const workspace = join(directory, "workspace");
const temp = join(directory, "temp");
const record = { experiment: "Isolated real TUI custom and manual dialogs plus long tool under PTY", result: "not-run" };
let requestCount = 0;
const server = createServer(async (req, res) => {
	try {
		if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
		let data = "";
		for await (const chunk of req) data += chunk;
		const body = JSON.parse(data);
		assert.equal(body.model, "probe");
		const requestIndex = requestCount++;
		if (requestIndex === 1) {
			const messages = Array.isArray(body.messages) ? body.messages : [];
			const receivedResult = messages.some((message) => message.role === "tool" && message.tool_call_id === "call_pty_long" && typeof message.content === "string" && message.content.includes("LONG_TOOL_DONE"));
			if (!receivedResult) record.unmatchedRequest = { requestIndex, roles: messages.slice(-5).map((message) => message.role), toolCallIds: messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id) };
			assert.ok(receivedResult, "Scripted model did not receive completed tool result");
			await writeFile(join(workspace, "model-saw-tool-result"), "yes");
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const base = { id: "chatcmpl-pty", object: "chat.completion.chunk", created: 1, model: "probe" };
		const send = (delta, finish) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
		if (requestIndex === 0) {
			const command = `node -e "require('fs').writeFileSync('tool-started','yes');setTimeout(()=>{require('fs').writeFileSync('tool-finished','yes');console.log('LONG_TOOL_DONE')},3500)"`;
			send({ role: "assistant", tool_calls: [{ index: 0, id: "call_pty_long", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }, null);
			send({}, "tool_calls");
		} else {
			send({ role: "assistant", content: "PTY_MODEL_DONE" }, null);
			send({}, "stop");
		}
		res.end("data: [DONE]\n\n");
	} catch (error) {
		record.serverError = String(error);
		res.writeHead(500); res.end(String(error));
	}
});

try {
	for (const path of [agentDir, workspace, temp]) await mkdir(path, { recursive: true });
	server.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { smoke: { api: "openai-completions", apiKey: "local-fixture-only", baseUrl, models: [{ id: "probe", contextWindow: 100000, maxTokens: 4096 }] } } }));
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ smoke: { type: "api_key", key: "local-fixture-only" } }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "smoke", defaultModel: "probe", defaultThinkingLevel: "off", defaultPermissionMode: "manual", memoryEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));
	const extension = join(directory, "fixture-extension.mjs");
	await writeFile(extension, `export default function(pi){pi.registerCommand('dialog-probe',{description:'Isolated dialog probe',handler:async(_args,ctx)=>{const choice=await ctx.ui.select('PTY custom dialog',['First','Second']);ctx.ui.notify('DIALOG_CHOICE '+choice,'info')}})}`);
	record.cleanInstall = await installCandidate(install, directory);
	const probe = fileURLToPath(new URL("./remote-pty-interactions-probe.cjs", import.meta.url));
	const cli = join(root, "packages", "coding-agent", "dist", "cli.js");
	const child = spawn(process.execPath, [probe, install, cli, workspace, home, agentDir, temp, extension], { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error("Interaction probe timed out")); }, 55_000);
		child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
	record.requestCount = requestCount;
	if (stdout.trim()) record.probe = JSON.parse(stdout);
	if (code !== 0 && stderr.trim()) record.failure = stderr.slice(-2000);
	assert.equal(code, 0, "PTY interaction probe failed");
	assert.equal(record.serverError, undefined, "Scripted provider rejected a request");
	assert.ok(requestCount >= 2, "Scripted model did not receive tool result");
	assert.equal(await readFile(join(workspace, "model-saw-tool-result"), "utf8"), "yes");
	assert.equal(await readFile(join(workspace, "tool-finished"), "utf8"), "yes");
	record.result = "passed";
} catch (error) {
	record.result = "failed";
	record.failure ??= String(error?.stack ?? error);
	process.exitCode = 1;
} finally {
	server.closeAllConnections();
	server.close();
	for (let attempt = 0; attempt < 15; attempt++) {
		try { await rm(directory, { recursive: true, force: true }); break; }
		catch (error) { if (attempt === 14) { record.cleanupFailure = String(error); record.result = "failed"; process.exitCode = 1; } else await new Promise((resolve) => setTimeout(resolve, 500)); }
	}
	console.log(JSON.stringify(record, null, 2));
}
