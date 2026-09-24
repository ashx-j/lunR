import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, sep } from "node:path";

const require = createRequire(import.meta.url);

export default function productPtyProbe(pi) {
	pi.registerCommand("phase0-native", {
		description: "Disposable native PTY check from product artifact",
		handler: async (_args, ctx) => {
			const root = realpathSync(process.env.PI_REMOTE_PHASE0_ARTIFACT_ROOT);
			const expected = `${join(root, "node_modules", "@lydell")}${sep}`;
			for (const name of ["@lydell/node-pty", `@lydell/node-pty-${process.platform}-${process.arch}`]) {
				if (!realpathSync(require.resolve(name)).startsWith(expected)) throw new Error(`${name} resolved outside disposable artifact`);
			}
			const { spawn } = require("@lydell/node-pty");
			const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
			const source = "process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',d=>{const input=d.toString();if(input.includes('PRODUCT_PTY_START'))console.log('PRODUCT_PTY_READY');if(input.includes('PRODUCT_PTY_PING'))console.log('PRODUCT_PTY_ACK');if(input.includes('PRODUCT_PTY_FINISH'))process.exit(0)})";
			const handshake = (executable, args, kind) => {
				const child = spawn(executable, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: root, env });
				return new Promise((resolve, reject) => {
					let text = "";
					let phase = "start";
					let exitCode;
					let signal;
					let lastEvent = "spawn";
					let dataEvents = 0;
					let settled = false;
					const finish = (error) => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						if (!error) return resolve();
						let kill = "not-needed";
						if (exitCode === undefined) {
							try { child.kill(); kill = "requested"; }
							catch (killError) { kill = killError?.code ?? "failed"; }
						}
						reject(new Error(`${kind} ${error}; pid=${child.pid ?? "unknown"}, phase=${phase}, last=${lastEvent}, exit=${exitCode ?? "pending"}, signal=${signal ?? "none"}, events=${dataEvents}, bytes=${text.length}, kill=${kill}, tail=${JSON.stringify(text.slice(-120))}`));
					};
					const timer = setTimeout(() => finish("handshake timed out"), 8000);
					child.onData((chunk) => {
						lastEvent = "data";
						text += chunk;
						dataEvents++;
						try {
							if (phase === "start" && text.includes("PRODUCT_PTY_READY")) {
								phase = "ping";
								child.write("PRODUCT_PTY_PING\r");
							}
							if (phase === "ping" && text.includes("PRODUCT_PTY_ACK")) {
								phase = "finish";
								child.write("PRODUCT_PTY_FINISH\r");
							}
						} catch (error) {
							finish(`write failed (${error?.code ?? "unknown"})`);
						}
					});
					child.onExit(({ exitCode: code, signal: childSignal }) => {
						exitCode = code;
						signal = childSignal;
						lastEvent = "exit";
						if (code === 0 && phase === "finish" && text.includes("PRODUCT_PTY_READY") && text.includes("PRODUCT_PTY_ACK")) finish();
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
				const nodeFailure = error?.message?.startsWith("node ") ? error.message : `node spawn failed (${error?.code ?? "unknown"})`;
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
				const diagnostic = `${nodeFailure}; nodePath={${nodePath}}, args=-e, directNode={${directNode}}, shell={${shell}}`;
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
			ctx.ui.notify("PRODUCT_PTY_NATIVE_OK", "info");
		},
	});
}
