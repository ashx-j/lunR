import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

const require = createRequire(import.meta.url);

export const productPtySource = "process.stdin.setRawMode?.(true);process.stdin.resume();let check,sizeReported=false;const reportSize=()=>{if(sizeReported)return;const size=process.stdout.getWindowSize?.();if(size?.join('x')==='112x36'){sizeReported=true;console.log('PRODUCT_PTY_SIZE 112x36');if(check)clearInterval(check)}};process.stdout.on('resize',reportSize);process.stdin.on('data',d=>{const input=d.toString();if(input.includes('PRODUCT_PTY_START'))console.log('PRODUCT_PTY_READY');if(input.includes('PRODUCT_PTY_PING')){console.log('PRODUCT_PTY_ACK');console.log('PRODUCT_PTY_OBSERVED_SIZE '+process.stdout.getWindowSize?.().join('x'));reportSize();if(!sizeReported)check=setInterval(reportSize,50)}if(input.includes('PRODUCT_PTY_FINISH'))process.exit(0)})";

export function spawnBunTerminal(executable, args, options) {
	const dataListeners = new Set();
	const exitListeners = new Set();
	const ptyExitListeners = new Set();
	let processExit;
	let ptyExit;
	const proc = Bun.spawn([executable, ...args], {
		cwd: options.cwd,
		env: { ...options.env, TERM: options.name },
		terminal: {
			name: options.name,
			cols: options.cols,
			rows: options.rows,
			data(_terminal, bytes) {
				const chunk = Buffer.from(bytes).toString("utf8");
				for (const listener of dataListeners) listener(chunk);
			},
			exit(_terminal, status, signal) {
				ptyExit = { status, signal };
				for (const listener of ptyExitListeners) listener(ptyExit);
			},
		},
	});
	const terminal = proc.terminal;
	if (!terminal) {
		proc.kill();
		throw new Error("Bun did not attach a terminal");
	}
	proc.exited.then((exitCode) => {
		processExit = { exitCode, signal: proc.signalCode };
		for (const listener of exitListeners) listener(processExit);
	}, () => {
		processExit = { exitCode: null, signal: proc.signalCode };
		for (const listener of exitListeners) listener(processExit);
	});
	let closed = false;
	return {
		pid: proc.pid,
		write: (text) => terminal.write(text),
		resize: (cols, rows) => terminal.resize(cols, rows),
		kill: () => proc.kill(),
		close: () => { if (!closed) { closed = true; terminal.close(); } },
		onData: (listener) => { dataListeners.add(listener); return { dispose: () => dataListeners.delete(listener) }; },
		onExit: (listener) => { if (processExit) listener(processExit); else exitListeners.add(listener); },
		onPtyExit: (listener) => { if (ptyExit) listener(ptyExit); else ptyExitListeners.add(listener); },
	};
}

export async function probeCompiledWorker(spawn, artifactRoot, disposableRoot) {
	const cli = realpathSync(join(artifactRoot, process.platform === "win32" ? "lunr.exe" : "lunr"));
	const base = mkdtempSync(join(disposableRoot, "compiled-worker-"));
	const home = join(base, "home");
	const workspace = join(base, "workspace");
	const temp = join(base, "tmp");
	const agentDir = join(home, ".lunr", "agent");
	for (const path of [agentDir, workspace, temp]) mkdirSync(path, { recursive: true });
	const resizeFile = join(temp, "viewport-control.json");
	writeFileSync(resizeFile, "");
	const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", TERM: "xterm-256color", PI_REMOTE_PHASE0_WORKER_RESIZE_FILE: resizeFile };
	const child = spawn(cli, ["--no-session", "--approve", "--extension", join(artifactRoot, "phase0-product-extension.mjs")], { cwd: workspace, name: "xterm-256color", cols: 80, rows: 24, env });
	let output = "";
	let repaint = "";
	let exited;
	let subscription = child.onData((chunk) => { output += chunk; });
	child.onExit((event) => { exited = event; });
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (predicate, label, ms) => {
		const deadline = Date.now() + ms;
		while (!predicate()) {
			if (exited || Date.now() >= deadline) throw new Error(`compiled worker missing ${label}; pid=${child.pid ?? "unknown"}, exit=${JSON.stringify(exited ?? "pending")}, outputBytes=${output.length}, tail=${JSON.stringify(output.slice(-220))}`);
			await sleep(50);
		}
	};
	try {
		if (!Number.isInteger(child.pid) || child.pid <= 0 || child.pid === process.pid) throw new Error(`compiled worker has invalid child pid ${child.pid}`);
		await waitFor(() => output.includes("\x1b[?1049h") && /> [^\r\n]*\r*\n[\s\S]*╰[^\r\n]*╯/.test(output), "complete TUI first paint", 20_000);
		await sleep(4500);
		child.write("/settings");
		await sleep(400);
		child.write("\r");
		await waitFor(() => output.includes("/settings") && output.includes("Auto-compact") && output.includes("Type to search"), "settings dialog after prompt input", 10_000);
		subscription.dispose();
		child.resize(108, 34);
		await sleep(300);
		if (exited) throw new Error("compiled worker exited while detached");
		subscription = child.onData((chunk) => { output += chunk; repaint += chunk; });
		child.resize(110, 35);
		await sleep(300);
		repaint = "";
		writeFileSync(resizeFile, JSON.stringify({ columns: 110, rows: 35 }));
		await waitFor(() => existsSync(`${resizeFile}.result`), "explicit resize receipt", 5000);
		const resizeReceipt = JSON.parse(readFileSync(`${resizeFile}.result`, "utf8"));
		if (resizeReceipt.columns !== 110 || resizeReceipt.rows !== 35 || resizeReceipt.observed !== "110x35") throw new Error(`compiled worker resize receipt: ${JSON.stringify(resizeReceipt)}`);
		try {
			await waitFor(() => repaint.includes("\x1b[2J") && /(?:^|\r*\n)─{110}(?=\x1b|\r*\n)/.test(repaint) && [...repaint.matchAll(/╰[^\r\n]*╯/g)].some(([border]) => border.length === (process.platform === "win32" ? 109 : 110)) && repaint.includes("Auto-compact") && repaint.includes("Type to search"), "complete 110-column settings repaint after reattachment", 10_000);
		} catch (error) {
			const borders = [...repaint.matchAll(/╰[^\r\n]*╯/g)].map(([border]) => border.length);
			throw new Error(`${error.message}; receipt=${JSON.stringify(resizeReceipt)}, repaintBytes=${repaint.length}, borders=${borders.join(",")}, clear=${repaint.includes("\x1b[2J")}, repaintHead=${JSON.stringify(repaint.slice(0, 320))}`);
		}
		child.write("\u001b");
		await sleep(300);
		if (exited) throw new Error("compiled worker exited after reattachment");
		return { pid: child.pid, executable: basename(cli), firstPaint: true, settings: true, repaintColumns: 110, workerAliveAfterDetach: true };
	} finally {
		subscription.dispose();
		child.kill();
		child.close?.();
	}
}

export default function productPtyProbe(pi) {
	const resizeFile = process.env.PI_REMOTE_PHASE0_WORKER_RESIZE_FILE;
	if (resizeFile) {
		let interval;
		let resizeEvents = 0;
		const onResize = () => { resizeEvents++; };
		pi.on("session_start", (_event, ctx) => {
			if (!ctx.hasUI) throw new Error("Compiled worker resize check requires a TUI");
			process.stdout.on("resize", onResize);
			ctx.ui.setWidget("phase0-viewport-control", (tui) => {
				queueMicrotask(() => ctx.ui.setWidget("phase0-viewport-control", undefined));
				interval = setInterval(() => {
					const content = readFileSync(resizeFile, "utf8");
					if (!content) return;
					clearInterval(interval);
					const { columns, rows } = JSON.parse(content);
					const observed = process.stdout.getWindowSize?.().join("x");
					const result = { columns: tui.terminal.columns, rows: tui.terminal.rows, observed, resizeEvents };
					if (columns === result.columns && rows === result.rows && observed === `${columns}x${rows}`) tui.requestRender(true);
					writeFileSync(`${resizeFile}.result`, JSON.stringify(result));
				}, 50);
				return { render: () => [] };
			});
		});
		pi.on("session_shutdown", () => {
			clearInterval(interval);
			process.stdout.off("resize", onResize);
		});
		return;
	}
	const selectArtifactPty = () => {
		const root = realpathSync(process.env.PI_REMOTE_PHASE0_ARTIFACT_ROOT);
		const bunTerminal = process.env.PI_REMOTE_PHASE0_STANDALONE_CLI === "1";
		if (bunTerminal) {
			if (process.versions.bun !== "1.4.2" || typeof Bun === "undefined" || typeof Bun.spawn !== "function") throw new Error("Bun 1.4.2 Terminal backend is required");
			if (existsSync(join(root, "node_modules", "@lydell", "node-pty"))) throw new Error("Standalone unexpectedly contains native PTY addon");
			return { root, bunTerminal, spawn: spawnBunTerminal };
		}
		const expected = `${join(root, "node_modules", "@lydell")}${sep}`;
		for (const name of ["@lydell/node-pty", `@lydell/node-pty-${process.platform}-${process.arch}`]) {
			if (!realpathSync(require.resolve(name)).startsWith(expected)) throw new Error(`${name} resolved outside disposable artifact`);
		}
		return { root, bunTerminal, spawn: require("@lydell/node-pty").spawn };
	};
	pi.registerCommand("phase0-native", {
		description: "Disposable native PTY check from product artifact",
		handler: async (_args, ctx) => {
			const { root, bunTerminal, spawn } = selectArtifactPty();
			const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
			const source = productPtySource;
			const handshake = (executable, args, kind) => {
				const child = spawn(executable, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: root, env });
				return new Promise((resolve, reject) => {
					let text = "";
					let phase = "start";
					let exitCode;
					let signal;
					let ptyStatus = "pending";
					let ptyStatusType = "pending";
					let lastEvent = "spawn";
					let dataEvents = 0;
					let settled = false;
					const finish = (error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						if (!error) {
							const statusAtCompletion = ptyStatus;
							try { child.close?.(); resolve({ ptyStatus: statusAtCompletion }); }
							catch (closeError) { reject(new Error(`${kind} terminal close failed (${closeError?.code ?? "unknown"})`)); }
							return;
						}
						let kill = "not-needed";
						if (exitCode === undefined) {
							try { child.kill(); kill = "requested"; }
							catch (killError) { kill = killError?.code ?? "failed"; }
						}
						try { child.close?.(); }
						catch (closeError) { kill += `, close=${closeError?.code ?? "failed"}`; }
						reject(new Error(`${kind} ${error}; pid=${child.pid ?? "unknown"}, phase=${phase}, last=${lastEvent}, exit=${exitCode ?? "pending"}, signal=${signal ?? "none"}, pty=${ptyStatus}, ptyType=${ptyStatusType}, events=${dataEvents}, bytes=${text.length}, kill=${kill}, tail=${JSON.stringify(text.slice(-120))}`));
					};
					const timer = setTimeout(() => finish("handshake timed out"), 8000);
					child.onData((chunk) => {
						lastEvent = "data";
						text += chunk;
						dataEvents++;
						try {
							if (phase === "start" && text.includes("PRODUCT_PTY_READY")) {
								if (bunTerminal) child.resize(112, 36);
								phase = "ping";
								child.write("PRODUCT_PTY_PING\r");
							}
							if (phase === "ping" && text.includes("PRODUCT_PTY_ACK") && (!bunTerminal || text.includes("PRODUCT_PTY_SIZE 112x36"))) {
								phase = "finish";
								child.write("PRODUCT_PTY_FINISH\r");
							}
						} catch (error) {
							finish(`write failed (${error?.code ?? "unknown"})`);
						}
					});
					child.onPtyExit?.(({ status }) => {
						const phaseAtExit = phase;
						ptyStatus = status;
						ptyStatusType = typeof status;
						lastEvent = "pty-eof";
						// Bun maps every master read error to 1; Linux may return EIO when the slave closes.
						const linuxClose = bunTerminal && process.platform === "linux" && phaseAtExit === "finish" && status === 1;
						if (status !== 0 && !linuxClose) finish(`PTY stream error (status=${JSON.stringify(status)}, type=${ptyStatusType}, phaseAtExit=${phaseAtExit})`);
						else if (status === 0 && phaseAtExit !== "finish") finish(`PTY EOF before FINISH (phaseAtExit=${phaseAtExit})`);
					});
					child.onExit(({ exitCode: code, signal: childSignal }) => {
						exitCode = code;
						signal = childSignal;
						lastEvent = "process-exit";
						if (code === 0 && phase === "finish" && text.includes("PRODUCT_PTY_READY") && text.includes("PRODUCT_PTY_ACK") && (!bunTerminal || text.includes("PRODUCT_PTY_SIZE 112x36"))) finish();
						else finish("exited before handshake completed");
					});
					try {
						lastEvent = "write-start";
						child.write("PRODUCT_PTY_START\r");
					} catch (error) {
						finish(`write failed (${error?.code ?? "unknown"})`);
					}
				});
			};
			const executable = process.env.PI_REMOTE_PHASE0_NODE_EXECUTABLE;
			let proof;
			try {
				proof = await handshake(executable, ["-e", source], "node");
			} catch (error) {
				if (process.platform === "win32") throw error;
				let diagnostic = error?.message?.startsWith("node ") ? error.message : `node spawn failed (${error?.code ?? "unknown"})`;
				if (bunTerminal) {
					diagnostic = `bun-terminal ${diagnostic}`;
				} else {
					let nodePath = `absolute=${isAbsolute(executable ?? "")}, name=${basename(executable ?? "")}`;
					try {
						const resolved = realpathSync(executable);
						accessSync(resolved, constants.X_OK);
						nodePath += `, executable=true, resolvedName=${basename(resolved)}`;
					} catch {
						nodePath += ", executable=false";
					}
					let directNode;
					try {
						const direct = spawnSync(executable, ["-e", source], { cwd: root, env, input: "PRODUCT_PTY_START\nPRODUCT_PTY_PING\n", encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
						directNode = `exit=${direct.status ?? "none"}, ready=${direct.stdout?.includes("PRODUCT_PTY_READY") ?? false}, ack=${direct.stdout?.includes("PRODUCT_PTY_ACK") ?? false}, error=${direct.error?.code ?? "none"}`;
					} catch (directError) {
						directNode = `threw=${directError?.code ?? "unknown"}`;
					}
					const shellSource = 'IFS= read -r start || exit 11; [ "$start" = PRODUCT_PTY_START ] || exit 12; printf "PRODUCT_PTY_READY\\n"; IFS= read -r ping || exit 13; [ "$ping" = PRODUCT_PTY_PING ] || exit 14; printf "PRODUCT_PTY_ACK\\n"; IFS= read -r finish || exit 15; [ "$finish" = PRODUCT_PTY_FINISH ] || exit 16';
					let shell = "passed";
					try {
						await handshake("/bin/sh", ["-c", shellSource], "shell");
					} catch (shellError) {
						shell = shellError?.message?.startsWith("shell ") ? shellError.message : `spawn failed (${shellError?.code ?? "unknown"})`;
					}
					diagnostic += `; nodePath={${nodePath}}, args=-e, directNode={${directNode}}, shell={${shell}}`;
				}
				const diagnosticFile = process.env.PI_REMOTE_PHASE0_DIAGNOSTIC_FILE;
				if (diagnosticFile) {
					try {
						writeFileSync(`${diagnosticFile}.tmp`, diagnostic, { flag: "wx" });
						renameSync(`${diagnosticFile}.tmp`, diagnosticFile);
					} catch (writeError) {
						throw new Error(`${diagnostic}; diagnosticWrite=${writeError?.code ?? "unknown"}`);
					}
				}
				throw new Error(diagnostic);
			}
			ctx.ui.notify(bunTerminal ? `PRODUCT_PTY_BUN_TERMINAL_OK_PTY_${proof.ptyStatus}` : "PRODUCT_PTY_NATIVE_OK", "info");
		},
	});
	pi.registerCommand("phase0-worker", {
		description: "Disposable compiled-host PTY check for the real compiled TUI",
		handler: async (_args, ctx) => {
			if (process.env.PI_REMOTE_PHASE0_STANDALONE_CLI !== "1") throw new Error("Compiled worker check requires a standalone artifact");
			const { root, bunTerminal, spawn } = selectArtifactPty();
			const diagnosticFile = process.env.PI_REMOTE_PHASE0_DIAGNOSTIC_FILE;
			if (!diagnosticFile) throw new Error("Compiled worker check needs an isolated diagnostic directory");
			let worker;
			try {
				worker = await probeCompiledWorker(spawn, root, dirname(diagnosticFile));
			} catch (error) {
				writeFileSync(diagnosticFile, `compiled worker: ${error.message}`);
				throw error;
			}
			ctx.ui.notify(`PRODUCT_PTY_WORKER_OK_${bunTerminal ? "BUN" : "NATIVE"}_PID_${worker.pid}_${worker.executable === "lunr.exe" ? "LUNR_EXE" : "LUNR"}_COLS_${worker.repaintColumns}`, "info");
		},
	});
}
