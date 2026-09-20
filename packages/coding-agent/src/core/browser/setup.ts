import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export async function installBrowser(): Promise<void> {
	const require = createRequire(import.meta.url);
	const cli = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`Chromium setup failed (${code}). Browser was not enabled; retry lunr features enable browser.`,
					),
				);
		});
	});
}
