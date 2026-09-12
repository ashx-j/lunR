// Exercises the built CLI and real TUI with runtime hydration held indefinitely.
// Run after the offline package builds: node scripts/check-interactive-first-paint.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStartupMilestones } from "./profile-coding-agent-node.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.argv[2] ? resolve(process.argv[2]) : join(root, "packages/coding-agent/dist/cli.js");
const dist = dirname(cli);

async function check(fail) {
	const agentDir = mkdtempSync(join(tmpdir(), "lunr-paint-check-"));
	const fixture = `export async function main() {
process.stderr.write("FIXTURE_RUNTIME_WAIT\\n");
${fail ? 'await new Promise(r => setTimeout(r, 200)); throw new Error("fixture hydration failure");' : "await new Promise(() => {});"}
}`;
	const preload = `import { registerHooks } from "node:module";
registerHooks({ load(url, context, nextLoad) {
 if (${JSON.stringify([pathToFileURL(join(dist, "main.js")).href, pathToFileURL(join(dist, "node-runtime/main.js")).href])}.includes(url)) return { format: "module", shortCircuit: true, source: ${JSON.stringify(fixture)} };
 return nextLoad(url, context);
}});`;
	const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli], {
		cwd: agentDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_STARTUP_BENCHMARK: "1",
			PI_TIMING: "1",
			PI_OFFLINE: "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let exited = false;
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const exit = new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			exited = true;
			resolveExit(code);
		});
	});
	const waitFor = async (predicate) => {
		const deadline = Date.now() + 5000;
		while (!predicate()) {
			if (exited || Date.now() >= deadline)
				throw new Error(`Startup check did not reach its expected state: ${stderr}`);
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	};
	try {
		await waitFor(() => stderr.includes("FIXTURE_RUNTIME_WAIT"));
		await waitFor(() => stdout.includes("╰"));
		assert(stdout.includes("> "));
		assert(!stdout.includes("Starting lunR"));
		assert(stderr.indexOf('"first_frame_committed"') < stderr.indexOf("FIXTURE_RUNTIME_WAIT"));
		assert(!stderr.includes('"runtime_hydrated"'));
		if (fail) {
			assert.equal(await exit, 1);
		} else {
			child.stdin.write("draft");
			await waitFor(() => stdout.includes("draft"));
			child.stdin.write("\x03\x03");
			await waitFor(() => exited);
			assert.equal(await exit, 0);
		}
		assert.equal(stdout.split("\x1b[?1049h").length - 1, 1);
		assert(stdout.includes("\x1b[?1049l"), "terminal must be restored on exit");
		console.log(`${fail ? "failed" : "stalled"} runtime: real frame before hydration, terminal restored`);
	} finally {
		if (!exited) {
			child.kill();
			await exit;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const optionalModules = [
	"pi-web-access/extract.js",
	"pi-web-access/gemini-search.js",
	"pi-web-access/curator-server.js",
	"pi-lsp-extension/src/lsp-manager.js",
	"pi-lsp-extension/src/tree-sitter/parser-manager.js",
	"pi-subagents/src/runs/foreground/subagent-executor.js",
	"pi-mcp-adapter/init.js",
	"pi-mcp-adapter/mcp-auth-flow.js",
	"pi-mcp-adapter/commands.js",
	"pi-mcp-adapter/server-manager.js",
	"pi-mcp-adapter/proxy-modes.js",
	"pi-mcp-adapter/direct-tool-executor.js",
];

async function checkRequest(toolUrl, toolKind) {
	const agentDir = mkdtempSync(join(tmpdir(), "lunr-request-check-"));
	const home = join(agentDir, "home");
	const workspace = join(home, "workspace");
	const temp = join(agentDir, "tmp");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(temp);
	writeFileSync(join(workspace, "index.ts"), "export function increment(value: number) { return value + 1; }\n");
	writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ ssrf: { allowRanges: ["127.0.0.1/32"] } }));
	const blocked = optionalModules.map((name) => pathToFileURL(join(dist, "builtin-extensions", name)).href);
	if (existsSync(join(dist, "node-runtime/cli-runtime.js"))) {
		const metadata = JSON.parse(readFileSync(join(root, ".artifacts/node-runtime/metafile.json"), "utf8"));
		for (const [output, details] of Object.entries(metadata.outputs)) {
			if (
				Object.keys(details.inputs).some((input) =>
					optionalModules.some((name) => input.endsWith(`/builtin-extensions/${name}`)),
				)
			) {
				blocked.push(pathToFileURL(join(dist, "node-runtime", basename(output))).href);
			}
		}
	}
	const preload = `import { registerHooks } from "node:module";
const blocked = new Set(${JSON.stringify(blocked)});
registerHooks({load(url, context, nextLoad) {
 if (blocked.has(url)) return {format:"module",shortCircuit:true,source:'process.stderr.write("OPTIONAL_IMPORT_BLOCKED\\\\n"); await new Promise(() => {});'};
 return nextLoad(url,context);
}});`;
	const child = spawn(
		process.execPath,
		[
			...(toolUrl || toolKind ? [] : ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]),
			cli,
			"--no-session",
			"--no-approve",
		],
		{
			cwd: workspace,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				APPDATA: home,
				LOCALAPPDATA: home,
				TMP: temp,
				TEMP: temp,
				TMPDIR: temp,
				PI_CODING_AGENT_DIR: agentDir,
				PI_STARTUP_BENCHMARK: "1",
				PI_TIMING: "1",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_STARTUP_BENCHMARK_TOOL_URL: toolUrl ?? "",
				PI_STARTUP_BENCHMARK_TOOL: toolKind ?? "",
			},
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const timer = setTimeout(() => child.kill(), 15000);
	try {
		const code = await new Promise((done, reject) => {
			child.once("exit", done);
			child.once("error", reject);
		});
		assert.equal(code, 0, stderr);
		assert(!stderr.includes("OPTIONAL_IMPORT_BLOCKED"), stderr);
		const requestLine = stderr.split(/\r?\n/).find((line) => line.startsWith("LUNR_STARTUP_REQUEST "));
		assert(requestLine, stderr);
		const request = JSON.parse(requestLine.slice("LUNR_STARTUP_REQUEST ".length));
		for (const name of [
			"read",
			"bash",
			"edit",
			"write",
			"subagent",
			"web_search",
			"fetch_content",
			"mcp",
			"lsp_diagnostics",
			"ast_search",
			"cron",
		]) {
			assert(request.tools.includes(name), `First request is missing ${name}`);
		}
		assert.equal(
			request.toolSchemaHash,
			"0f319cade6933ac2e08d192739d11063897eeda2ed798c088062150bc82cbe06",
			"First request tool payload differs from the baseline fixture",
		);
		assert(request.hasSystemPrompt);
		assert(stderr.includes('"first_response_completed"'), stderr);
		if (toolUrl || toolKind) assert(stderr.includes('"first_tool_completed"'), stderr);
		const milestones = parseStartupMilestones(stderr);
		const requestMs = milestones.get("first_request_dispatched");
		const toolMs = milestones.get("first_tool_completed");
		console.log(
			toolUrl
				? "first-turn fetch: real local HTTP extraction completed"
				: toolKind
					? `first-turn ${toolKind}: lazy implementation completed`
					: "stalled optional implementations: first request retains tools and instructions",
		);
		console.log(
			`  request ${requestMs.toFixed(1)}ms${toolMs === undefined ? "" : `; first tool +${(toolMs - requestMs).toFixed(1)}ms`}`,
		);
	} finally {
		clearTimeout(timer);
		rmSync(agentDir, { recursive: true, force: true });
	}
}

await check(false);
await check(true);
await checkRequest();
for (const tool of ["subagent", "mcp", "lsp"]) await checkRequest(undefined, tool);
const server = createServer((_request, response) => {
	response.writeHead(200, { "Content-Type": "text/html" });
	response.end(
		`<html><head><title>Startup fixture</title></head><body><article><h1>Startup fixture</h1>${"<p>This local article verifies that the first fetch tool loads its extraction implementation and reads the complete page without an external provider.</p>".repeat(30)}</article></body></html>`,
	);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
try {
	await checkRequest(`http://127.0.0.1:${server.address().port}/article`);
} finally {
	await new Promise((done) => server.close(done));
}
