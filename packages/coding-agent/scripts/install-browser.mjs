import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const truthy = (value) => /^(1|true|yes)$/i.test(value ?? "");
const explicit = process.argv.includes("--explicit");
if ([process.env.PI_OFFLINE, process.env.npm_config_offline, process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, process.env.npm_config_package_lock_only].some(truthy)) {
	console.error("Chromium installation skipped for offline/skip-download mode. If needed later, run: lunr browser install");
} else {
	try {
		const require = createRequire(import.meta.url);
		const cli = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
		const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", windowsHide: true });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Chromium installer exited ${result.status}`);
	} catch (error) {
		console.error(`Chromium is not ready: ${error instanceof Error ? error.message : String(error)}. Other lunr tools remain available. Run lunr browser install when online.`);
		if (explicit) process.exitCode = 1;
	}
}
