import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCandidate } from "./remote-pty-probe-install.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "lunr-pty-attach-"));
const install = join(directory, "install");
const home = join(directory, "home");
const agentDir = join(home, ".lunr", "agent");
const workspace = join(directory, "workspace");
const temp = join(directory, "temp");
const portFile = join(directory, "control-port");
const record = { experiment: "Same-size terminal reattachment and bounded synthetic PNG upload using actual TUI", result: "not-run" };
let imageReceived = false;
let requests = 0;
const provider = createServer(async (req, res) => {
	try {
		if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		assert.equal(body.model, "probe");
		requests++;
		const user = body.messages.findLast((message) => message.role === "user");
		const summary = JSON.stringify(user);
		record.userSummaries ??= [];
		record.userSummaries.push({ contentTypes: Array.isArray(user?.content) ? user.content.map((part) => part.type) : typeof user?.content, hasMarker: summary.includes("[image_1]") });
		imageReceived ||= Array.isArray(user?.content) && user.content.some((part) =>
			part.type === "image_url" && JSON.stringify(part).includes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const base = { id: "chatcmpl-phase0", object: "chat.completion.chunk", created: 1, model: "probe" };
		for (const [delta, finish_reason] of [[{ role: "assistant", content: "IMAGE_RECEIVED" }, null], [{}, "stop"]]) {
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		}
		res.end("data: [DONE]\n\n");
	} catch (error) {
		record.providerFailure = String(error);
		res.writeHead(500); res.end(String(error));
	}
});

try {
	for (const path of [agentDir, workspace, temp]) await mkdir(path, { recursive: true });
	provider.listen(0, "127.0.0.1");
	await new Promise((resolve) => provider.once("listening", resolve));
	const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { smoke: { api: "openai-completions", apiKey: "local-fixture-only", baseUrl, models: [{ id: "probe", contextWindow: 100000, maxTokens: 4096, input: ["text", "image"] }] } } }));
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ smoke: { type: "api_key", key: "local-fixture-only" } }));
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "smoke", defaultModel: "probe", defaultThinkingLevel: "off", defaultPermissionMode: "auto", memoryEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));
	record.cleanInstall = await installCandidate(install, directory);
	const childScript = fileURLToPath(new URL("./remote-pty-attach-bridge-probe.cjs", import.meta.url));
	const extension = fileURLToPath(new URL("./remote-pty-phase0-extension.mjs", import.meta.url));
	const cli = join(root, "packages", "coding-agent", "dist", "cli.js");
	const token = randomBytes(24).toString("hex");
	const child = spawn(process.execPath, [childScript, install, cli, workspace, home, agentDir, temp, extension, portFile], { cwd: workspace, env: { ...process.env, PI_REMOTE_PHASE0_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (data) => { stdout += data; });
	child.stderr.on("data", (data) => { stderr += data; });
	const code = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error("Attachment probe timed out")); }, 45_000);
		child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
	record.result = code === 0 ? "passed" : "failed";
	if (stdout.trim()) record.probe = JSON.parse(stdout);
	if (code !== 0) record.failure = stderr.slice(-1800);
	assert.equal(code, 0);
	assert.equal(imageReceived, true, "Synthetic image bytes did not reach the model request");
	assert.ok(requests >= 1, "Fixture expected a prompt submission");
	record.imageReceived = imageReceived;
	record.modelRequests = requests;
} catch (error) {
	record.failure ??= String(error?.stack ?? error);
	process.exitCode = 1;
} finally {
	provider.closeAllConnections();
	provider.close();
	for (let attempt = 0; attempt < 15; attempt++) {
		try { await rm(directory, { recursive: true, force: true }); break; }
		catch (error) { if (attempt === 14) { record.cleanupFailure = String(error); process.exitCode = 1; } else await new Promise((resolve) => setTimeout(resolve, 500)); }
	}
	console.log(JSON.stringify(record, null, 2));
}
