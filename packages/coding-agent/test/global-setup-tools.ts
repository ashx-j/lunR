import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_AGENT_DIR } from "../src/config.ts";

/**
 * Downloads fd and rg once per checkout and puts them on PATH for every test worker. `test.sh`
 * gives each run a new profile, so without this every run downloaded both again and a failed
 * download failed the grep and find tool tests.
 */
export default async function setup(): Promise<void> {
	const cacheDir = fileURLToPath(new URL("../../../node_modules/.cache/lunr-test-tools", import.meta.url));
	const profile = process.env[ENV_AGENT_DIR];
	// tools-manager reads its bin directory when it loads, so point it at the cache first.
	process.env[ENV_AGENT_DIR] = cacheDir;
	try {
		const { ensureTool } = await import("../src/utils/tools-manager.ts");
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	} finally {
		if (profile === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = profile;
	}
	process.env.PATH = `${join(cacheDir, "bin")}${delimiter}${process.env.PATH ?? ""}`;
}
