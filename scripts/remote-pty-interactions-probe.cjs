const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const [install, cli, workspace, home, agentDir, temp, extension] = process.argv.slice(2);
const pty = createRequire(join(install, "entry.cjs"))("@lydell/node-pty");
const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color" };
const child = pty.spawn(process.execPath, [cli, "--no-session", "--approve", "--provider", "smoke", "--model", "probe", "--extension", extension], { cwd: workspace, name: "xterm-256color", cols: 80, rows: 24, env });
let workerPid;
let output = "";
let exited;
child.onExit((event) => { exited = event; });
let subscription = child.onData((chunk) => { output += chunk; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition, label, ms = 12000) => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (exited || Date.now() > deadline) throw new Error(`Missing ${label}; exited=${JSON.stringify(exited)}; tail=${output.slice(-1100)}`);
		await sleep(50);
	}
};
const writeText = async (text) => { child.write(text); await sleep(200); };

async function run() {
	const observations = {};
	try {
		await waitFor(() => output.includes("╭") && output.includes("> "), "real TUI first paint", 20000);
		workerPid = child.pid;
		assert.ok(workerPid > 0, "ConPTY worker has no process ID after first paint");
		await sleep(4000);
		await writeText("/dialog-probe");
		await writeText("\r");
		await waitFor(() => output.includes("PTY custom dialog") && output.includes("First"), "custom extension dialog");
		observations.customDialogPending = true;
		subscription.dispose();
		child.resize(104, 32);
		await sleep(500);
		assert.equal(exited, undefined, "Worker exited during custom dialog detach");
		let reconnect = "";
		subscription = child.onData((chunk) => { output += chunk; reconnect += chunk; });
		child.resize(106, 34);
		await sleep(400);
		assert.ok(reconnect.includes("PTY custom dialog") || reconnect.includes("First"), "Custom dialog was not visible after reattachment");
		await writeText("\r");
		await waitFor(() => output.includes("DIALOG_CHOICE First"), "custom dialog response");
		observations.customDialogAcrossDetach = true;
		await writeText("Run the long fixture tool");
		await writeText("\r");
		await waitFor(() => output.includes("Approve once"), "manual approval", 20000);
		observations.manualApprovalPending = true;
		subscription.dispose();
		child.resize(108, 35);
		await sleep(500);
		assert.equal(exited, undefined, "Worker exited during manual approval detach");
		let approvalRepaint = "";
		subscription = child.onData((chunk) => { output += chunk; approvalRepaint += chunk; });
		child.resize(110, 36);
		await sleep(400);
		assert.ok(approvalRepaint.includes("Approve once"), "Manual approval was not visible after reattachment");
		await writeText("\r");
		await waitFor(() => fs.existsSync(join(workspace, "tool-started")), "long tool start");
		observations.manualApprovalAcrossDetach = true;
		subscription.dispose();
		child.resize(112, 37);
		await sleep(1200);
		assert.equal(exited, undefined, "Worker exited during long tool detach");
		assert.ok(!fs.existsSync(join(workspace, "tool-finished")), "Tool finished before detached interval");
		await waitFor(() => fs.existsSync(join(workspace, "tool-finished")), "long tool completion while detached", 9000);
		let toolRepaint = "";
		subscription = child.onData((chunk) => { output += chunk; toolRepaint += chunk; });
		child.resize(114, 38);
		await waitFor(() => (output.includes("PTY_MODEL_DONE") || toolRepaint.includes("LONG_TOOL_DONE")) && fs.existsSync(join(workspace, "model-saw-tool-result")), "model continuation with scripted tool result", 15000);
		observations.longToolCompletedWhileDetached = true;
		observations.workerPidUnchanged = child.pid === workerPid && !exited;
		assert.ok(observations.workerPidUnchanged, `Worker identity/liveness changed: ${JSON.stringify({ pid: child.pid, workerPid, exited })}`);
		console.log(JSON.stringify(observations));
	} finally {
		subscription.dispose();
		child.kill();
		for (let i = 0; i < 50 && !exited; i++) await sleep(100);
	}
	process.exit(0);
}
run().catch((error) => { console.error(error); child.kill(); process.exit(1); });
