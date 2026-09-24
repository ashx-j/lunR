const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const editorFrame = require("./remote-pty-tui-frame.cjs");

const [install, cli, workspace, home, agentDir, temp] = process.argv.slice(2);
const pty = createRequire(join(install, "entry.cjs"))("@lydell/node-pty");
const extension = process.env.PI_REMOTE_PHASE0_NATIVE_EXTENSION;
const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", PI_REMOTE_PHASE0_ARTIFACT_ROOT: process.env.PI_REMOTE_PHASE0_ARTIFACT_ROOT, PI_REMOTE_PHASE0_NODE_EXECUTABLE: process.execPath, PI_REMOTE_PHASE0_DIAGNOSTIC_FILE: process.env.PI_REMOTE_PHASE0_DIAGNOSTIC_FILE, PI_REMOTE_PHASE0_STANDALONE_CLI: process.env.PI_REMOTE_PHASE0_STANDALONE_CLI };
const args = ["--no-session", "--approve", ...(extension ? ["--extension", extension] : [])];
const standalone = process.env.PI_REMOTE_PHASE0_STANDALONE_CLI === "1";
const artifactPtyBackend = standalone && process.platform !== "win32" ? "bun-terminal" : "native-addon";
const child = pty.spawn(standalone ? cli : process.execPath, standalone ? args : [cli, ...args], { cwd: workspace, name: "xterm-256color", cols: 80, rows: 24, env });
let exited;
child.onExit((event) => { exited = event; });
let screen = "";
const first = child.onData((chunk) => { screen += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (pattern, ms) => {
	const start = Date.now();
	while (!pattern.test(screen)) {
		const diagnosticFile = process.env.PI_REMOTE_PHASE0_DIAGNOSTIC_FILE;
		const hasDiagnostic = Boolean(extension && diagnosticFile && fs.existsSync(diagnosticFile));
		if (exited || hasDiagnostic || Date.now() - start > ms) {
			const diagnostic = hasDiagnostic ? `, nativeDiagnostic=${JSON.stringify(fs.readFileSync(diagnosticFile, "utf8").slice(-1100))}` : "";
			throw new Error(`TUI output missing ${pattern}; exited=${JSON.stringify(exited)}, bytes=${screen.length}, slash=${screen.includes("/settings")}${diagnostic}, tail=${screen.slice(-700)}`);
		}
		await sleep(50);
	}
};

async function run() {
	try {
		await waitFor(/\x1b\[\?1049h/, 20_000);
		await waitFor(/╭[^\r\n]*╮/, 20_000);
		await waitFor(editorFrame, 20_000);
		await sleep(4500);
		if (extension) {
			child.write("/phase0-native\r");
			await waitFor(artifactPtyBackend === "bun-terminal" ? /PRODUCT_PTY_BUN_TERMINAL_OK/ : /PRODUCT_PTY_NATIVE_OK/, standalone && process.platform !== "win32" ? 30000 : 15000);
		}
		child.write("/settings");
		await sleep(400);
		child.write("\r");
		await sleep(1200);
		const settingsDialogSeen = screen.includes("Auto-compact") && screen.includes("Type to search");
		const inputEchoSeen = screen.includes("/settings");
		first.dispose();
		child.resize(112, 36);
		await sleep(500);
		let reattached = "";
		const next = child.onData((chunk) => { reattached += chunk; });
		child.resize(110, 35);
		await sleep(500);
		child.write("\u001b");
		await sleep(700);
		next.dispose();
		assert.equal(exited, undefined, "TUI exited while unattached");
		assert.ok(inputEchoSeen, "PTY input did not reach the real TUI editor");
		assert.ok(settingsDialogSeen, "Settings dialog did not open");
		const borders = [...reattached.matchAll(/╭[^\r\n]*╮/g)].map(([border]) => border.length);
		assert.ok(borders.length, "Reattached client received no complete frame after resize");
		assert.ok(borders.includes(110), `Reattached frame did not use the new 110-column viewport: ${borders.join(",")}`);
		console.log(JSON.stringify({ result: "passed", platform: `${process.platform}-${process.arch}`, tuiFirstPaint: true, settingsDialogSeen, inputEchoSeen, workerAliveAfterDetach: true, artifactPtyBackend: extension ? artifactPtyBackend : "none", artifactNativeSpawn: Boolean(extension && artifactPtyBackend === "native-addon"), reattachedOutputBytes: reattached.length, repaintColumns: borders, dimensions: [110, 35], scope: extension ? "isolated installed product artifact and artifact-local PTY" : "isolated actual worktree CLI; no agent inference" }));
	} finally {
		child.kill();
		for (let i = 0; i < 50 && !exited; i++) await sleep(100);
	}
	process.exit(0);
}
run().catch((error) => { console.error(error); child.kill(); process.exit(1); });
