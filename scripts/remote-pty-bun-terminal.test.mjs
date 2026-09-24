import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import productPtyProbe, { probeCompiledWorker, productPtySource, spawnBunTerminal } from "./remote-pty-product-extension.mjs";

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

async function withBunHandshake(run, platformName = "linux") {
	const root = mkdtempSync(join(tmpdir(), "lunr-bun-pty-order-"));
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	const bunVersion = process.versions.bun;
	const oldBun = globalThis.Bun;
	const keys = ["PI_REMOTE_PHASE0_ARTIFACT_ROOT", "PI_REMOTE_PHASE0_NODE_EXECUTABLE", "PI_REMOTE_PHASE0_STANDALONE_CLI", "PI_REMOTE_PHASE0_DIAGNOSTIC_FILE"];
	const previousEnv = new Map(keys.map((key) => [key, process.env[key]]));
	const state = { writes: [], resizes: [], closes: 0, kills: 0, finishStatus: 0, earlyEof: false, earlyError: false };
	let resolveExit;
	const exited = new Promise((resolve) => { resolveExit = resolve; });
	try {
		Object.defineProperty(process, "platform", { ...platform, value: platformName });
		process.versions.bun = "1.4.2";
		process.env.PI_REMOTE_PHASE0_ARTIFACT_ROOT = root;
		process.env.PI_REMOTE_PHASE0_NODE_EXECUTABLE = process.execPath;
		process.env.PI_REMOTE_PHASE0_STANDALONE_CLI = "1";
		delete process.env.PI_REMOTE_PHASE0_DIAGNOSTIC_FILE;
		globalThis.Bun = {
			spawn(_args, options) {
				state.options = options;
				return {
					pid: 4321,
					signalCode: null,
					exited,
					kill() { state.kills++; },
					terminal: {
						write(value) {
							state.writes.push(value);
							if (value === "PRODUCT_PTY_START\r") {
							if (state.earlyEof || state.earlyError) options.terminal.exit(null, state.earlyError ? 1 : 0, null);
							else state.emit("PRODUCT_PTY_READY");
							} else if (value === "PRODUCT_PTY_PING\r") state.emit("PRODUCT_PTY_ACK");
							else if (value === "PRODUCT_PTY_FINISH\r") options.terminal.exit(null, state.finishStatus, null);
							return value.length;
						},
						resize(cols, rows) { state.resizes.push([cols, rows]); },
						close() { state.closes++; options.terminal.exit(null, 0, null); },
					},
				};
			},
		};
		state.emit = (chunk) => state.options.terminal.data(null, new TextEncoder().encode(chunk));
		let handler;
		productPtyProbe({ registerCommand(name, registration) { if (name === "phase0-native") handler = registration.handler; } });
		await run({ state, handler, resolveExit });
	} finally {
		Object.defineProperty(process, "platform", platform);
		if (bunVersion === undefined) delete process.versions.bun;
		else process.versions.bun = bunVersion;
		if (oldBun === undefined) delete globalThis.Bun;
		else globalThis.Bun = oldBun;
		for (const [key, value] of previousEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test("old size cannot pass; EOF after FINISH waits for the subprocess", async () => {
	await withBunHandshake(async ({ state, handler, resolveExit }) => {
		let notice;
		const pending = handler("", { ui: { notify(value) { notice = value; } } });
		assert.deepEqual(state.resizes, [[112, 36]]);
		state.emit("PRODUCT_PTY_SIZE 80x24");
		assert.equal(state.writes.includes("PRODUCT_PTY_FINISH\r"), false);
		state.emit("PRODUCT_PTY_SIZE 112x36");
		assert.equal(state.writes.at(-1), "PRODUCT_PTY_FINISH\r");
		await Promise.resolve();
		assert.equal(notice, undefined);
		resolveExit(0);
		await pending;
		assert.equal(notice, "PRODUCT_PTY_BUN_TERMINAL_OK_PTY_0");
		assert.equal(state.closes, 1);
		assert.equal(state.kills, 0);
	});
});

test("Linux terminal status 1 after FINISH waits for subprocess exit 0", async () => {
	await withBunHandshake(async ({ state, handler, resolveExit }) => {
		state.finishStatus = 1;
		let notice;
		const pending = handler("", { ui: { notify(value) { notice = value; } } });
		state.emit("PRODUCT_PTY_SIZE 112x36");
		assert.equal(state.writes.at(-1), "PRODUCT_PTY_FINISH\r");
		await Promise.resolve();
		assert.equal(notice, undefined);
		resolveExit(0);
		await pending;
		assert.equal(notice, "PRODUCT_PTY_BUN_TERMINAL_OK_PTY_1");
		assert.equal(state.kills, 0);
	});
});

test("premature EOF, stream error, and nonzero subprocess exit reject", async () => {
	for (const variant of ["early", "error", "nonzero", "linux-error-nonzero", "mac-error"]) {
		await withBunHandshake(async ({ state, handler, resolveExit }) => {
			state.earlyEof = variant === "early";
			state.earlyError = variant === "error";
			state.finishStatus = variant === "linux-error-nonzero" || variant === "mac-error" ? 1 : 0;
			const pending = handler("", { ui: { notify() { assert.fail("Failed PTY cannot report success"); } } });
			if (variant !== "early" && variant !== "error") state.emit("PRODUCT_PTY_SIZE 112x36");
			if (variant === "nonzero" || variant === "linux-error-nonzero") resolveExit(7);
			const expected = variant === "early" ? /PTY EOF before FINISH \(phaseAtExit=start\)/ : variant === "error" ? /PTY stream error \(status=1, type=number, phaseAtExit=start\)/ : variant === "mac-error" ? /PTY stream error \(status=1, type=number, phaseAtExit=finish\)/ : /exited before handshake completed.*exit=7/;
			await assert.rejects(pending, expected);
			assert.equal(state.closes, 1);
		}, variant === "mac-error" ? "darwin" : "linux");
	}
});

test("child reports the actual resized dimensions after an old-size response", () => {
	for (const trigger of ["resize", "poll"]) {
		const lines = [];
		let input;
		let resize;
		let poll;
		let cleared = false;
		let dimensions = [80, 24];
		runInNewContext(productPtySource, {
			process: {
				stdin: { setRawMode() {}, resume() {}, on(_event, listener) { input = listener; } },
				stdout: { getWindowSize() { return dimensions; }, on(_event, listener) { resize = listener; } },
			},
			console: { log(value) { lines.push(value); } },
			setInterval(callback, ms) { assert.equal(ms, 50); poll = callback; return 1; },
			clearInterval(id) { assert.equal(id, 1); cleared = true; },
		});
		input(Buffer.from("PRODUCT_PTY_START"));
		input(Buffer.from("PRODUCT_PTY_PING"));
		assert.deepEqual(lines, ["PRODUCT_PTY_READY", "PRODUCT_PTY_ACK", "PRODUCT_PTY_OBSERVED_SIZE 80x24"]);
		assert.equal(lines.includes("PRODUCT_PTY_SIZE 112x36"), false);
		assert.equal(typeof poll, "function");
		dimensions = [112, 36];
		if (trigger === "resize") resize();
		else poll();
		assert.equal(lines.at(-1), "PRODUCT_PTY_SIZE 112x36");
		assert.equal(cleared, true);
		poll();
		assert.equal(lines.filter((line) => line === "PRODUCT_PTY_SIZE 112x36").length, 1);
	}
});

test("isolated worker control requests a full TUI repaint only for observed dimensions", async () => {
	const root = mkdtempSync(join(tmpdir(), "lunr-worker-repaint-"));
	const file = join(root, "viewport.json");
	writeFileSync(file, "");
	const previous = process.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE;
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "getWindowSize");
	process.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE = file;
	Object.defineProperty(process.stdout, "getWindowSize", { configurable: true, value: () => [110, 35] });
	const listeners = new Map();
	const renders = [];
	let columns = 80;
	try {
		productPtyProbe({ on(event, handler) { listeners.set(event, handler); } });
		listeners.get("session_start")({}, { hasUI: true, ui: { setWidget(_key, factory) {
			if (factory) factory({ terminal: { get columns() { return columns; }, rows: 35 }, requestRender(force) { renders.push(force); } });
		} } });
		await Promise.resolve();
		columns = 110;
		writeFileSync(file, JSON.stringify({ columns: 110, rows: 35 }));
		const deadline = Date.now() + 1000;
		while (!existsSync(`${file}.result`) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(JSON.parse(readFileSync(`${file}.result`, "utf8")), { columns: 110, rows: 35, observed: "110x35", resizeEvents: 0 });
		assert.deepEqual(renders, [true]);
	} finally {
		listeners.get("session_shutdown")?.();
		if (descriptor) Object.defineProperty(process.stdout, "getWindowSize", descriptor);
		else delete process.stdout.getWindowSize;
		if (previous === undefined) delete process.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE;
		else process.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("compiled host PTY owns a distinct real-CLI worker across settings detach and resize", async () => {
	const directory = mkdtempSync(join(tmpdir(), "lunr-worker-pty-"));
	const artifact = join(directory, "artifact");
	mkdirSync(artifact);
	const cli = join(artifact, process.platform === "win32" ? "lunr.exe" : "lunr");
	writeFileSync(cli, "fixture");
	let killed = 0;
	let closed = 0;
	const resizes = [];
	const listeners = new Set();
	const emit = (text) => { for (const listener of listeners) listener(text); };
	try {
		const result = await probeCompiledWorker((executable, args, options) => {
			assert.equal(executable, cli);
			assert.deepEqual(args, ["--no-session", "--approve", "--extension", join(artifact, "phase0-product-extension.mjs")]);
			assert.ok(options.cwd.startsWith(directory));
			assert.ok(options.env.PI_CODING_AGENT_DIR.startsWith(directory));
			assert.equal(options.env.PI_REMOTE_PHASE0_NATIVE_EXTENSION, undefined);
			assert.ok(options.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE.startsWith(directory));
			queueMicrotask(() => emit("\x1b[?1049h╭──╮\n> \n╰──╯"));
			return {
				pid: process.pid + 1,
				onData(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
			onExit() {},
			write(text) {
				if (text === "/settings") emit("/settings");
				if (text === "\r") emit("Auto-compact Type to search");
			},
			resize(cols, rows) {
				resizes.push([cols, rows, listeners.size]);
				if (cols === 110) {
					writeFileSync(`${options.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE}.result`, JSON.stringify({ columns: 110, rows: 35, observed: "110x35", resizeEvents: 2 }));
					setTimeout(() => emit(`\x1b[2J\r\n${"─".repeat(110)}\x1b[m\r\n╰${"─".repeat(107)}╯ Auto-compact Type to search`), 400);
				}
			},
			kill() { killed++; },
			close() { closed++; },
			};
		}, artifact, directory);
		assert.deepEqual(resizes, [[108, 34, 0], [110, 35, 1]]);
		assert.deepEqual(result, { pid: process.pid + 1, executable: process.platform === "win32" ? "lunr.exe" : "lunr", firstPaint: true, settings: true, repaintColumns: 110, workerAliveAfterDetach: true });
		assert.equal(killed, 1);
		assert.equal(closed, 1);
		assert.equal(listeners.size, 0);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
