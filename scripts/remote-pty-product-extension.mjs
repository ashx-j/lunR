import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, sep } from "node:path";

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
		onData: (listener) => { dataListeners.add(listener); },
		onExit: (listener) => { if (processExit) listener(processExit); else exitListeners.add(listener); },
		onPtyExit: (listener) => { if (ptyExit) listener(ptyExit); else ptyExitListeners.add(listener); },
	};
}

export default function productPtyProbe(pi) {
	pi.registerCommand("phase0-native", {
		description: "Disposable native PTY check from product artifact",
		handler: async (_args, ctx) => {
			const root = realpathSync(process.env.PI_REMOTE_PHASE0_ARTIFACT_ROOT);
			const bunUnix = process.env.PI_REMOTE_PHASE0_STANDALONE_CLI === "1" && process.platform !== "win32";
			let spawn;
			if (bunUnix) {
				if (process.versions.bun !== "1.3.14" || typeof Bun === "undefined" || typeof Bun.spawn !== "function") throw new Error("Bun 1.3.14 Terminal backend is required");
				if (existsSync(join(root, "node_modules", "@lydell", "node-pty"))) throw new Error("Unix standalone unexpectedly contains native PTY addon");
				spawn = spawnBunTerminal;
			} else {
				const expected = `${join(root, "node_modules", "@lydell")}${sep}`;
				for (const name of ["@lydell/node-pty", `@lydell/node-pty-${process.platform}-${process.arch}`]) {
					if (!realpathSync(require.resolve(name)).startsWith(expected)) throw new Error(`${name} resolved outside disposable artifact`);
				}
				spawn = require("@lydell/node-pty").spawn;
			}
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
							try { child.close?.(); resolve({ ptyStatus }); }
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
								if (bunUnix) child.resize(112, 36);
								phase = "ping";
								child.write("PRODUCT_PTY_PING\r");
							}
							if (phase === "ping" && text.includes("PRODUCT_PTY_ACK") && (!bunUnix || text.includes("PRODUCT_PTY_SIZE 112x36"))) {
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
						if (status !== 0) finish(`PTY stream error (status=${JSON.stringify(status)}, type=${ptyStatusType}, phaseAtExit=${phaseAtExit})`);
						else if (phaseAtExit !== "finish") finish(`PTY EOF before FINISH (phaseAtExit=${phaseAtExit})`);
					});
					child.onExit(({ exitCode: code, signal: childSignal }) => {
						exitCode = code;
						signal = childSignal;
						lastEvent = "process-exit";
						if (code === 0 && phase === "finish" && text.includes("PRODUCT_PTY_READY") && text.includes("PRODUCT_PTY_ACK") && (!bunUnix || text.includes("PRODUCT_PTY_SIZE 112x36"))) finish();
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
			try {
				await handshake(executable, ["-e", source], "node");
			} catch (error) {
				if (process.platform === "win32") throw error;
				let diagnostic = error?.message?.startsWith("node ") ? error.message : `node spawn failed (${error?.code ?? "unknown"})`;
				if (bunUnix) {
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
			ctx.ui.notify(bunUnix ? "PRODUCT_PTY_BUN_TERMINAL_OK" : "PRODUCT_PTY_NATIVE_OK", "info");
		},
	});
}
