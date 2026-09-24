const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const [install, cli, workspace, home, agentDir, temp, extension, portFile] = process.argv.slice(2);
const pty = createRequire(join(install, "entry.cjs"))("@lydell/node-pty");
const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", PI_REMOTE_PHASE0_TOKEN: process.env.PI_REMOTE_PHASE0_TOKEN, PI_REMOTE_PHASE0_PORT_FILE: portFile, PI_REMOTE_PHASE0_UPLOAD_DIR: temp };
const worker = pty.spawn(process.execPath, [cli, "--no-session", "--approve", "--provider", "smoke", "--model", "probe", "--extension", extension], { cwd: workspace, name: "xterm-256color", cols: 80, rows: 24, env });
let output = "";
let capture = (chunk) => { output += chunk; };
let discardedBytes = 0;
let markerBuffer = "";
let exited;
worker.onExit((event) => { exited = event; });
const subscription = worker.onData((chunk) => {
	if (capture) capture(chunk);
	else discardedBytes += Buffer.byteLength(chunk);
	markerBuffer = (markerBuffer + chunk).slice(-2048);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition, label, ms = 12000) => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (exited || Date.now() > deadline) throw new Error(`Missing ${label}; exited=${JSON.stringify(exited)}; tail=${output.slice(-650)}`);
		await sleep(30);
	}
};
let port;
const control = async (message, authorized = true) => {
	const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json", "x-phase0-token": authorized ? process.env.PI_REMOTE_PHASE0_TOKEN : "wrong" }, body: JSON.stringify(message), signal: AbortSignal.timeout(5000) });
	return { status: response.status, body: await response.json() };
};
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

async function run() {
	try {
		await waitFor(() => output.includes("╭") && output.includes("> "), "real TUI paint", 20000);
		await sleep(4000);
		worker.write("/phase0-bind\r");
		await waitFor(() => fs.existsSync(portFile), "isolated extension control port");
		port = Number(fs.readFileSync(portFile, "utf8"));
		assert.equal((await control({ action: "prepare" }, false)).status, 403);
		worker.write("/settings\r");
		await waitFor(() => output.includes("Auto-compact") && output.includes("Type to search"), "settings dialog");
		capture = null;
		worker.write("\u001b");
		await sleep(350);
		worker.write("persist-draft");
		await sleep(450);
		assert.equal(exited, undefined);
		assert.ok(discardedBytes > 0, "Worker did not drain output while unattached");
		const prepared = await control({ action: "prepare" });
		assert.equal(prepared.status, 200);
		await waitFor(() => markerBuffer.includes(prepared.body.marker), "PTY output boundary");
		assert.equal((await control({ action: "repaint", generation: prepared.body.generation - 1 })).status, 409);
		let reattached = "";
		capture = (chunk) => { output += chunk; reattached += chunk; };
		const repainted = await control({ action: "repaint", generation: prepared.body.generation });
		assert.equal(repainted.status, 200);
		await waitFor(() => reattached.includes("persist-draft") && /╭[^\r\n]*╮/.test(reattached), "same-size full frame");
		assert.match(reattached, /\x1b\[2J/, "Repaint did not clear the physical terminal");
		assert.ok(!reattached.includes("Auto-compact"), "Stale detached settings output was replayed");
		assert.ok(!reattached.includes(prepared.body.marker), "Output boundary leaked to attached client");
		assert.equal(worker.pid > 0, true);
		worker.write("\u0015");
		await sleep(250);
		assert.equal((await control({ action: "image", generation: prepared.body.generation, mimeType: "image/jpeg", data: tinyPng })).status, 400);
		assert.equal((await control({ action: "image", generation: prepared.body.generation, mimeType: "image/png", data: Buffer.alloc(1024 * 1024 + 1).toString("base64") })).status, 413);
		const image = await control({ action: "image", generation: prepared.body.generation, mimeType: "image/png", data: tinyPng });
		assert.deepEqual(image, { status: 200, body: { id: 1 } });
		await waitFor(() => reattached.includes("[image_1]"), "normal image chip");
		worker.write("Describe this image\r");
		await waitFor(() => reattached.includes("IMAGE_RECEIVED"), "scripted model answer", 20000);
		console.log(JSON.stringify({ result: "passed", sameSizeRepaint: true, staleBytesDiscarded: discardedBytes, draftPreserved: true, clearSequenceSeen: true, syntheticPngChip: true, boundEnforced: true, staleGenerationRejected: true, unauthorizedRejected: true }));
	} finally {
		subscription.dispose();
		worker.kill();
		for (let i = 0; i < 50 && !exited; i++) await sleep(100);
	}
	process.exit(0);
}
run().catch((error) => { console.error(error); worker.kill(); process.exit(1); });
