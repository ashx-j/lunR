const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { join } = require("node:path");

const install = process.argv[2];
const directory = process.argv[3];
const requireCandidate = createRequire(join(install, "entry.cjs"));
const pty = requireCandidate("@lydell/node-pty");
assert.equal(typeof pty.spawn, "function");

async function run() {
	const source = "process.stdin.setRawMode?.(true);process.stdin.resume();let n=0;console.log('READY');const t=setInterval(()=>{console.log('TICK '+ ++n);if(n===5){clearInterval(t);process.exit(0)}},300);process.stdin.on('data',d=>console.log('INPUT '+d.toString().trim()))";
	const child = pty.spawn(process.execPath, ["-e", source], { name: "xterm-256color", cols: 80, rows: 24, cwd: directory, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TERM: "xterm-256color" } });
	let before = "";
	const attached = child.onData((chunk) => { before += chunk; });
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("PTY did not start")), 5000);
		const poll = setInterval(() => {
			if (before.includes("READY")) { clearInterval(poll); clearTimeout(timer); resolve(); }
		}, 20);
	});
	attached.dispose();
	child.resize(112, 36);
	await new Promise((resolve) => setTimeout(resolve, 700));
	let after = "";
	const reattached = child.onData((chunk) => { after += chunk; });
	child.write("synthetic-clipboard-bytes\r");
	const exit = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("PTY did not exit")), 6000);
		child.onExit((event) => { clearTimeout(timer); resolve(event); });
	});
	reattached.dispose();
	assert.equal(exit.exitCode, 0);
	assert.match(before, /READY/);
	assert.match(after, /TICK [345]/);
	assert.match(after, /INPUT synthetic-clipboard-bytes/);
	console.log(JSON.stringify({ result: "passed", platform: `${process.platform}-${process.arch}`, beforeReady: true, afterTicks: true, afterInput: true, exit, cols: 112, rows: 36, scope: "isolated Node subprocess, not lunR TUI" }));
	process.exit(0);
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
