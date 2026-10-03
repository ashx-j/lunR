import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";

export async function installBrowser(explicit = true): Promise<void> {
	if (isBunBinary) {
		throw new Error(
			"Chromium installation is unavailable in the compiled standalone executable. Install the same lunR version through npm and run lunr browser install there. Use the same PLAYWRIGHT_BROWSERS_PATH for installation and standalone execution.",
		);
	}
	const script = fileURLToPath(new URL("../../../scripts/install-browser.mjs", import.meta.url));
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...(explicit ? ["--explicit"] : [])], {
			stdio: "inherit",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Chromium setup failed (${code}). Retry lunr browser install when online.`));
		});
	});
}
