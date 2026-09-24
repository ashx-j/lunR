import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";

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
			const source = "process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on('data',d=>{const input=d.toString();if(input.includes('PRODUCT_PTY_START'))console.log('PRODUCT_PTY_READY');if(input.includes('PRODUCT_PTY_PING'))console.log('PRODUCT_PTY_ACK');if(input.includes('PRODUCT_PTY_FINISH'))process.exit(0)})";
			const child = spawn(process.env.PI_REMOTE_PHASE0_NODE_EXECUTABLE, ["-e", source], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: root,
				env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
			});
			await new Promise((resolve, reject) => {
				let text = "";
				let phase = "start";
				let exitCode;
				let dataEvents = 0;
				let settled = false;
				const finish = (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (!error) return resolve();
					if (exitCode === undefined) child.kill();
					reject(new Error(`${error}; phase=${phase}, exit=${exitCode ?? "pending"}, dataEvents=${dataEvents}, bytes=${text.length}, tail=${JSON.stringify(text.slice(-240))}`));
				};
				const timer = setTimeout(() => finish("Native PTY handshake timed out"), 8000);
				child.onData((chunk) => {
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
						finish(`Native PTY write failed: ${error}`);
					}
				});
				child.onExit(({ exitCode: code }) => {
					exitCode = code;
					if (code === 0 && phase === "finish" && text.includes("PRODUCT_PTY_READY") && text.includes("PRODUCT_PTY_ACK")) finish();
					else finish("Native PTY exited before handshake completed");
				});
				try {
					child.write("PRODUCT_PTY_START\r");
				} catch (error) {
					finish(`Native PTY write failed: ${error}`);
				}
			});
			ctx.ui.notify("PRODUCT_PTY_NATIVE_OK", "info");
		},
	});
}
