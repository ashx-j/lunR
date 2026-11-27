import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read by name and not through `config.ts`: loading that module fills an unset variable with the
// home default, which would hide a bare run from the check below.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Runs once before the test workers start.
 *
 * Downloads fd and rg once per checkout and puts them on PATH for every worker. `test.sh` gives
 * each run a new profile, so without this every run downloaded both again and a failed download
 * failed the grep and find tool tests.
 *
 * A bare `vitest` run has no profile from `test.sh`, so it gets a disposable agent directory here.
 * Without one, tests that build a real session read and wrote the developer's own `~/.lunr/agent`.
 */
export default async function setup(): Promise<() => void> {
	const cacheDir = fileURLToPath(new URL("../../../node_modules/.cache/lunr-test-tools", import.meta.url));
	const ownProfile = process.env[ENV_AGENT_DIR]?.trim() ? undefined : mkdtempSync(join(tmpdir(), "lunr-vitest-"));
	const profile = ownProfile ?? process.env[ENV_AGENT_DIR];
	// tools-manager reads its bin directory when it loads, so point it at the cache first.
	process.env[ENV_AGENT_DIR] = cacheDir;
	try {
		const { ensureTool } = await import("../src/utils/tools-manager.ts");
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	} finally {
		process.env[ENV_AGENT_DIR] = profile;
	}
	process.env.PATH = `${join(cacheDir, "bin")}${delimiter}${process.env.PATH ?? ""}`;
	return () => {
		if (ownProfile) rmSync(ownProfile, { recursive: true, force: true });
	};
}
