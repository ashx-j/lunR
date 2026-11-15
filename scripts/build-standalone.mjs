import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Match Node's optional-module behavior without excluding Playwright or HTML extraction.
// LinkeDOM catches a missing canvas renderer; canvas is absent from the CLI production graph.
// Playwright loads these undeclared imports only for its BiDi-over-CDP adapter, which lunR
// does not select. Keep their real runtime requires, including missing-module errors.
export const standaloneExternalArgs = [
	"--external=canvas",
	"--external=chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
	"--external=chromium-bidi/lib/cjs/cdp/CdpConnection",
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const result = spawnSync(
		"bun",
		[
			"build",
			"--compile",
			...standaloneExternalArgs,
			"./dist/bun/cli.js",
			"./src/utils/image-resize-worker.ts",
			...process.argv.slice(2),
		],
		{ cwd: fileURLToPath(new URL("../packages/coding-agent/", import.meta.url)), stdio: "inherit" },
	);
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}
