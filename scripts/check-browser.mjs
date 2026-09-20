import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts", "browser-smoke");
mkdirSync(artifacts, { recursive: true });
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
assert(browsers, "Explicitly install Chromium and set PLAYWRIGHT_BROWSERS_PATH before this check.");

function respond(response, call, finishText) {
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const delta = call
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "browser", arguments: JSON.stringify(call) } }] }
		: { role: "assistant", content: finishText };
	const base = { id: "browser-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
	response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function check(mode) {
	const profile = mkdtempSync(join(tmpdir(), "lunr-browser-check-"));
	const home = join(profile, "home");
	const workspace = join(profile, "workspace");
	const agentDir = join(home, ".lunr", "agent");
	for (const dir of [home, workspace, agentDir]) mkdirSync(dir, { recursive: true });
	let index = 0;
	let error;
	let child;
	let posts = 0;
	const checks = [];
	const server = createServer(async (request, response) => {
		if (request.url === "/page") {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end('<!doctype html><h1>Before JS</h1><label>Name<input></label><button onclick="document.querySelector(\'h1\').textContent=\'Hello \'+document.querySelector(\'input\').value;fetch(\'/effect\',{method:\'POST\'})">Submit</button><script>document.querySelector("h1").textContent="Rendered JS fixture"</script>');
			return;
		}
		if (request.url === "/effect") { posts++; response.end("ok"); return; }
		try {
			let raw = "";
			for await (const chunk of request) raw += chunk;
			const body = JSON.parse(raw);
			const last = JSON.stringify(body.messages.filter((message) => message.role === "tool").at(-1) ?? "");
			const url = `http://127.0.0.1:${server.address().port}/page`;
			if (index === 0) {
				assert(body.tools.some((tool) => tool.function.name === "browser"));
				writeFileSync(join(artifacts, `${mode}-tools.json`), JSON.stringify(body.tools, null, 2));
				const prompt = body.messages.filter((message) => ["system", "developer"].includes(message.role)).map((message) => message.content).join("\n\n");
				writeFileSync(join(artifacts, `${mode}-system-prompt.txt`), prompt);
			}
			if (mode === "missing") {
				if (index++ === 0) return respond(response, { action: "navigate", url });
				assert(last.includes("Nothing was installed"));
				assert(last.includes("lunr features enable browser"));
				checks.push("missing Chromium returns explicit setup guidance");
				return respond(response, undefined, "browser-check-ok");
			}
			const calls = [
				{ action: "navigate", url }, { action: "inspect" },
				{ action: "act", interaction: "fill", label: "Name", value: "Ada" },
				{ action: "act", interaction: "click", role: "button", name: "Submit" },
				{ action: "inspect" }, { action: "screenshot" }, { action: "close" },
			];
			if (index === 2) { assert(last.includes("Rendered JS fixture")); checks.push("JavaScript snapshot"); }
			if (index === 3 || index === 4) {
				assert(last.includes(mode === "plan" ? "Browser interactions require" : "Interaction completed"), last);
			}
			if (index === 5) {
				assert(last.includes(mode === "plan" ? "Rendered JS fixture" : "Hello Ada"));
				assert.equal(posts, mode === "plan" ? 0 : 1);
				checks.push(mode === "plan" ? "plan blocks both interactions with zero website writes" : "fill/click produces one website write");
			}
			if (index === 6) { assert(last.includes("Untrusted viewport screenshot")); checks.push("explicit screenshot"); }
			if (index === 7) { assert(last.includes("Browser closed")); checks.push("explicit close"); }
			respond(response, calls[index++], "browser-check-ok");
		} catch (failure) {
			error = failure;
			response.writeHead(500).end(String(failure));
			child?.kill();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", apiKey: "local-placeholder", baseUrl, models: [{ id: "fixture", contextWindow: 272000, maxTokens: 4096 }] } } }));
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-placeholder" } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultPermissionMode: mode === "plan" ? "plan" : "auto", defaultThinkingLevel: "off", memoryEnabled: false, retry: { enabled: false }, compaction: { enabled: false } }));
	writeFileSync(join(agentDir, "install-features.json"), JSON.stringify({ schemaVersion: 1, features: { browser: { enabled: true, options: { "allow-private-network": true } } } }));
	const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PLAYWRIGHT_BROWSERS_PATH: mode === "missing" ? join(profile, "missing-browsers") : browsers };
	for (const key of Object.keys(env)) if (/^PI_(?:SUBAGENTS?|INTERCOM|STARTUP_BENCHMARK)/.test(key)) delete env[key];
	env.PI_SUBAGENT_CHILD = "1";
	env.PI_SUBAGENT_CHILD_PERMISSION = mode === "plan" ? "read-only" : "full";
	child = spawn(process.execPath, [join(root, "packages/coding-agent/dist/cli.js"), "--mode", "json", "--no-session", "--no-context-files", "--no-approve", "-p", "--provider", "fixture", "--model", "fixture", "Exercise the isolated browser fixture."], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = ""; let stderr = "";
	let completed = false;
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (!completed && stdout.includes("browser-check-ok")) {
			completed = true;
			setTimeout(() => child.kill(), 500).unref();
		}
	});
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const timer = setTimeout(() => child.kill(), 45000);
	try {
		const [code] = await once(child, "exit");
		if (error) throw error;
		assert(completed, `CLI did not complete: ${stderr}`);
		assert(code === 0 || code === null, stderr);
		console.log(`${mode}: PASS, ${checks.join(", ")}`);
		writeFileSync(join(artifacts, `${mode}-result.json`), JSON.stringify({ checks, exitCode: code, posts }, null, 2));
	} finally {
		clearTimeout(timer);
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
		try { process.kill(Number(readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8"))); } catch (failure) {
			if (!["ENOENT", "ESRCH"].includes(failure.code)) throw failure;
		}
	}
}

for (const mode of ["auto", "plan", "missing"]) await check(mode);
