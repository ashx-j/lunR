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
			const child = spawn(process.env.PI_REMOTE_PHASE0_NODE_EXECUTABLE, ["-e", "console.log('PRODUCT_PTY_READY')"], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd: root,
				env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
			});
			await new Promise((resolve, reject) => {
				let text = "";
				const timer = setTimeout(() => reject(new Error("Native PTY did not exit")), 5000);
				child.onData((chunk) => { text += chunk; });
				child.onExit(({ exitCode }) => {
					clearTimeout(timer);
					if (exitCode === 0 && text.includes("PRODUCT_PTY_READY")) resolve();
					else reject(new Error(`PTY exit ${exitCode}: ${text}`));
				});
			});
			ctx.ui.notify("PRODUCT_PTY_NATIVE_OK", "info");
		},
	});
}
