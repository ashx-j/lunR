import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnBunTerminal } from "./remote-pty-product-extension.mjs";

test("Bun terminal EOF is separate from subprocess exit", async () => {
	const originalBun = globalThis.Bun;
	let options;
	let command;
	let resolveExit;
	const exited = new Promise((resolve) => { resolveExit = resolve; });
	const writes = [];
	const resizes = [];
	let closes = 0;
	let kills = 0;
	globalThis.Bun = {
		spawn(args, settings) {
			command = args;
			options = settings;
			return {
				pid: 4321,
				signalCode: null,
				exited,
				kill() { kills++; },
				terminal: {
					write(value) { writes.push(value); return value.length; },
					resize(cols, rows) { resizes.push([cols, rows]); },
					close() { closes++; },
				},
			};
		},
	};
	try {
		const child = spawnBunTerminal("/test/node", ["-e", "script"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/test", env: { PATH: "/test" } });
		const data = [];
		const ptyExits = [];
		const processExits = [];
		child.onData((chunk) => data.push(chunk));
		child.onPtyExit((event) => ptyExits.push(event));
		child.onExit((event) => processExits.push(event));
		options.terminal.data(null, new TextEncoder().encode("PRODUCT_PTY_READY"));
		options.terminal.exit(null, 0, null);
		assert.deepEqual(data, ["PRODUCT_PTY_READY"]);
		assert.deepEqual(ptyExits, [{ status: 0, signal: null }]);
		assert.deepEqual(processExits, []);
		assert.deepEqual(command, ["/test/node", "-e", "script"]);
		assert.deepEqual(options.env, { PATH: "/test", TERM: "xterm-256color" });
		assert.equal(child.write("PRODUCT_PTY_PING\r"), 17);
		child.resize(112, 36);
		assert.deepEqual(writes, ["PRODUCT_PTY_PING\r"]);
		assert.deepEqual(resizes, [[112, 36]]);
		resolveExit(0);
		await exited;
		await Promise.resolve();
		assert.deepEqual(processExits, [{ exitCode: 0, signal: null }]);
		child.close();
		child.close();
		assert.equal(closes, 1);
		assert.equal(kills, 0);
	} finally {
		if (originalBun === undefined) delete globalThis.Bun;
		else globalThis.Bun = originalBun;
	}
});
