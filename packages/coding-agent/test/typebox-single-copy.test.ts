import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the built Node bundle (dist/cli.js), as CI does after its build step.
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(packageDir, "dist");

// A scripted model plus a tool whose schema comes from the extension's own typebox import.
const extensionSource = `
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export default function (pi) {
	const faux = createFauxCore({ provider: "copies" });
	faux.setResponses([fauxAssistantMessage("done")]);
	pi.registerProvider("copies", { api: faux.api, apiKey: "local-only", baseUrl: "http://localhost:0", models: faux.models, streamSimple: faux.streamSimple });
	pi.registerTool({ name: "copies_probe", label: "probe", description: "Probe.", parameters: Type.Object({ a: Type.String() }), execute: async () => ({ content: [], details: {} }) });
}
`;

// Records every loaded module URL, in-thread, next to lunR's own resolve hook.
const loadHookSource = `
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const urls = [];
registerHooks({ load(url, context, nextLoad) { urls.push(url); return nextLoad(url, context); } });
process.on("exit", () => writeFileSync(process.env.TYPEBOX_COPIES_LOG, urls.join("\\n")));
`;

describe("typebox copies in a print turn", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(packageDir, ".typebox-copies-"));
		writeFileSync(join(dir, "ext.ts"), extensionSource);
		writeFileSync(join(dir, "load-hook.mjs"), loadHookSource);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const typeboxModules = async (cliPath: string, name: string) => {
		const log = join(dir, `${name}.log`);
		const agentDir = join(dir, `agent-${name}`);
		mkdirSync(agentDir, { recursive: true });
		await promisify(execFile)(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(dir, "load-hook.mjs")).href,
				cliPath,
				"-p",
				"--no-session",
				"-e",
				join(dir, "ext.ts"),
				"--model",
				"copies/faux-1",
				"hi",
			],
			{ cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TYPEBOX_COPIES_LOG: log }, timeout: 60_000 },
		);
		const urls = readFileSync(log, "utf8").split("\n");
		return {
			installed: urls.filter((url) => url.includes("/typebox/build/")).length,
			prebuilt: urls.filter((url) => url.includes("/node-runtime/typebox/")).length,
		};
	};

	it("loads only the prebuilt typebox, for the CLI and the extension", async () => {
		const copies = await typeboxModules(join(dist, "cli.js"), "current");
		expect(copies.installed).toBe(0);
		expect(copies.prebuilt).toBeGreaterThan(0);
	});

	// An installed typebox at another version than the prebuilt one (an npm override): every
	// importer, the extension included, must get the installed copy.
	it("loads only the installed typebox when its version differs from the prebuilt one", async () => {
		const layout = join(dir, "dist");
		mkdirSync(layout);
		for (const entry of readdirSync(dist, { withFileTypes: true })) {
			if (entry.name === "node-runtime") continue;
			if (entry.isDirectory()) symlinkSync(join(dist, entry.name), join(layout, entry.name), "junction");
			else cpSync(join(dist, entry.name), join(layout, entry.name));
		}
		cpSync(join(dist, "node-runtime"), join(layout, "node-runtime"), { recursive: true });
		const manifestPath = join(layout, "node-runtime", "typebox", "manifest.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "0.0.0" }),
		);
		const copies = await typeboxModules(join(layout, "cli.js"), "stale");
		expect(copies.prebuilt).toBe(0);
		expect(copies.installed).toBeGreaterThan(0);
	});
});
