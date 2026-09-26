import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-gateway-check-"));
const agentDir = path.join(temporary, "profile");
const workspace = path.join(temporary, "project");
for (const directory of [agentDir, workspace]) fs.mkdirSync(directory, { recursive: true });
for (const key of Object.keys(process.env)) if (/^PI_SUBAGENT|^PI_INTERCOM|^PI_STARTUP_BENCHMARK/.test(key)) delete process.env[key];
Object.assign(process.env, { HOME: temporary, USERPROFILE: temporary, APPDATA: temporary, LOCALAPPDATA: temporary, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" });

let requests = 0;
let approved = false;
let failure;
const server = http.createServer(async (request, response) => {
	try {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		assert.equal(body.model, "local");
		const toolResult = body.messages.some((message) => message.role === "tool");
		assert(JSON.stringify(body.messages).replaceAll("\\\\", "/").toLowerCase().includes(workspace.replaceAll("\\", "/").toLowerCase()), "Gateway did not use the session's original project");
		if (requests === 0) {
			fs.mkdirSync(path.join(root, ".artifacts"), { recursive: true });
			fs.writeFileSync(path.join(root, ".artifacts", "gateway-tool-inventory.json"), JSON.stringify(body.tools, null, 2));
		}
		requests++;
		console.log(`Local provider request ${requests}, tool result: ${toolResult}`);
		response.writeHead(200, { "content-type": "text/event-stream" });
		const delta = toolResult
			? { role: "assistant", content: "gateway-local-ok" }
			: { role: "assistant", tool_calls: [{ index: 0, id: "write-output", type: "function", function: { name: "write", arguments: JSON.stringify({ path: path.join(workspace, "output.txt"), content: "gateway-file-ok" }) } }] };
		response.write(`data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		response.end(`data: ${JSON.stringify({ id: "local-reply", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta: {}, finish_reason: toolResult ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`);
	} catch (error) { failure = error; response.writeHead(500); response.end(String(error)); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "local-placeholder", baseUrl, models: [{ id: "local", contextWindow: 272000, maxTokens: 4096 }] } } }));
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-placeholder" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "local", defaultThinkingLevel: "off", defaultPermissionMode: "read-only", memoryEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));

const compiled = new URL("../packages/coding-agent/dist/", import.meta.url);
const load = (relative) => import(new URL(relative, compiled).href);
const [{ AgentBridge }, { createRouter }, { loadGatewayConfig, saveGatewayConfig }, { createPairingStore }, presentation, { SessionManager }, handoff, { buildSessionKey }, approval, buttons] = await Promise.all([
	load("gateway/agent-bridge.js"), load("gateway/router.js"), load("gateway/config.js"), load("gateway/pairing.js"), load("gateway/presenter.js"), load("core/session-manager.js"), load("core/session-handoff.js"), load("gateway/session-keys.js"), load("gateway/approval.js"), load("gateway/buttons.js"),
]);
const { canonicalSessionPath } = await load("core/session-ownership.js");
const cfg = loadGatewayConfig();
cfg.telegram.enabled = true;
cfg.telegram.allowedUsers = ["42"];
cfg.owners = { telegram: ["42"], discord: [] };
cfg.projectRoots = [workspace];
cfg.defaultProject = workspace;
cfg.streaming.enabled = false;
saveGatewayConfig(cfg);
const source = { platform: "telegram", chatId: "42", userId: "42", chatType: "dm" };
const delivered = [];
const files = [];
let nextId = 0;
let failedFinal = false;
let approvedContinuation = false;
const adapter = {
	platform: "telegram", maxMessageLength: 4096,
	connect: async () => true, disconnect: async () => {}, onMessage() {}, onCallback() {}, sendTyping: async () => {}, answerCallback: async () => {},
	send: async (_chat, text) => {
		if (text.includes("gateway-local-ok") && !failedFinal) { failedFinal = true; return { success: false, retryable: true, error: "isolated delivery failure" }; }
		delivered.push(text);
		return { success: true, messageId: String(++nextId) };
	},
	editMessage: async (_chat, _id, text) => { delivered.push(text); return { success: true }; },
	sendFile: async (_chat, file) => { files.push(fs.readFileSync(file, "utf8")); return { success: true }; },
	sendButtons: async (_chat, text, rows) => {
		delivered.push(text);
		const button = rows.flat().find((item) => item.label.includes("Approve once"));
		if (button) setTimeout(() => { approved = true; void approval.handleApprovalCallback({ id: "approve-local", userId: source.userId, chatId: source.chatId, data: button.data }, adapter); }, 0);
		const useYolo = rows.flat().find((item) => item.label === "Use yolo");
		if (useYolo) setTimeout(() => { approvedContinuation = true; void buttons.handleCallback({ id: "continue-local", userId: source.userId, chatId: source.chatId, data: useYolo.data }, { adapter, adapters, cfg, pairing: createPairingStore(), bridge }); }, 0);
		return { success: true, messageId: String(++nextId) };
	},
};
const adapters = new Map([["telegram", adapter]]);
presentation.startGatewayPresenter(adapters);
const bridge = new AgentBridge();
const router = createRouter({ adapters, cfg, pairing: createPairingStore(), bridge, remoteControls: true, reloadConfig: true });
const key = buildSessionKey(source, cfg);
const send = (text) => router.handleEvent({ text, source, messageId: String(++nextId) });
const desktop = SessionManager.create(workspace, path.join(agentDir, "sessions"));
desktop.appendMessage({ role: "user", content: "Earlier desktop work", timestamp: 1 });
desktop.flush();
desktop.setPermissionMode("yolo");
handoff.markSessionHandoff(desktop);
const sessionFile = desktop.getSessionFile();
desktop.dispose();
const deadline = setTimeout(() => { console.error("Gateway check timed out", delivered); try { const pid = Number(fs.readFileSync(path.join(agentDir, "intercom", "broker.pid"), "utf8").trim()); if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid); } catch {} process.exit(1); }, 45_000);
try {
	await send("/start");
	await send("/model fixture/local");
	await send("/continue");
	assert(approvedContinuation, "Writable continuation was not approved");
	assert.equal(canonicalSessionPath((await bridge.getSession(key))?.sessionManager?.getSessionFile()), canonicalSessionPath(sessionFile), delivered.join("\n"));
	await send("Write output.txt in this project with gateway-file-ok, then say gateway-local-ok.");
	if (failure) throw failure;
	assert.equal(requests, 2, delivered.join("\n"));
	assert(approvedContinuation, "Writable continuation was not confirmed on the phone");
	assert(failedFinal, "Expected the isolated final delivery failure");
	await new Promise((resolve) => setTimeout(resolve, 3100));
	await presentation.flushGatewayOutbox();
	assert.equal(delivered.filter((text) => text.includes("gateway-local-ok")).length, 1, delivered.join("\n"));
	await send("/download output.txt");
	assert.deepEqual(files, ["gateway-file-ok"]);
	await handoff.requestSessionTransfer(sessionFile);
	const reclaimed = SessionManager.open(sessionFile);
	try {
		assert.equal(reclaimed.getCwd(), workspace);
		assert.equal(reclaimed.getPermissionMode(), "yolo");
		assert(reclaimed.getEntries().some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("gateway-local-ok")));
	} finally { reclaimed.dispose(); }
	assert.equal(handoff.listHandoffCandidates().length, 1, "Continuation consumed the handoff mark");
	await send("/new");
	console.log("PASS: compiled gateway, first-use /start and /model, desktop continuation, write approval, failed final delivery recovery, /new, file download and reclaim.");
} catch (error) {
	process.exitCode = 1;
	console.error(error);
} finally {
	clearTimeout(deadline);
	await bridge.shutdown();
	presentation.stopGatewayPresenter();
	server.closeAllConnections(); server.close();
	try { const pid = Number(fs.readFileSync(path.join(agentDir, "intercom", "broker.pid"), "utf8").trim()); if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid); } catch {}
	fs.mkdirSync(path.join(root, ".artifacts"), { recursive: true });
	fs.writeFileSync(path.join(root, ".artifacts", "gateway-local-output.json"), JSON.stringify({ requests, approved, approvedContinuation, failedFinal, delivered, files }, null, 2));
	try {
		fs.rmSync(temporary, { recursive: true, force: true });
		console.log("Temporary fixture cleaned.");
	} catch {
		console.log("Temporary fixture retained under the OS temp directory while worker handles close.");
	}
}
