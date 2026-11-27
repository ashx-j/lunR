import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the built Node bundle (dist/cli.js), as CI does after its build step.
const packageDir = fileURLToPath(new URL("..", import.meta.url));

// A scripted model from an extension that imports all 3 workspace packages through jiti's aliases.
const extensionSource = `
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
export default function (pi) {
	const faux = createFauxCore({ provider: "bundles" });
	faux.setResponses([fauxAssistantMessage(\`done \${typeof Agent} \${typeof Text}\`)]);
	pi.registerProvider("bundles", { api: faux.api, apiKey: "local-only", baseUrl: "http://localhost:0", models: faux.models, streamSimple: faux.streamSimple });
}
`;

const loadHookSource = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const urls = [];
registerHooks({ load(url, context, nextLoad) { urls.push(url); return nextLoad(url, context); } });
process.on("exit", () => writeFileSync(process.env.PACKAGE_BUNDLES_LOG, urls.join("\\n")));
`;

describe("workspace package bundles", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(packageDir, ".package-bundles-"));
		writeFileSync(join(dir, "ext.ts"), extensionSource);
		writeFileSync(join(dir, "load-hook.mjs"), loadHookSource);
		mkdirSync(join(dir, "agent"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	// pi-ai's registries must exist once, shared by the CLI and extensions: every module of the
	// 3 packages comes from their dist/bundle/ build, none from the files tsgo wrote.
	it("loads pi-ai, pi-agent-core and pi-tui only from their single-file builds", async () => {
		const log = join(dir, "modules.log");
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(dir, "load-hook.mjs")).href,
				join(packageDir, "dist", "cli.js"),
				"-p",
				"--no-session",
				"-e",
				join(dir, "ext.ts"),
				"--model",
				"bundles/faux-1",
				"hi",
			],
			{
				cwd: dir,
				env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent"), PACKAGE_BUNDLES_LOG: log },
				timeout: 60_000,
			},
		);
		expect(stdout).toContain("done function function");
		const urls = readFileSync(log, "utf8").split("\n");
		const fromPackages = urls.filter((url) => /\/packages\/(ai|agent|tui)\/dist\//.test(url));
		expect(fromPackages.filter((url) => !url.includes("/dist/bundle/"))).toEqual([]);
		for (const name of ["ai", "agent", "tui"]) {
			expect(fromPackages.some((url) => url.includes(`/packages/${name}/dist/bundle/`))).toBe(true);
		}
	});
});
