import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTypeboxPrebundle } from "../../../scripts/build-typebox-prebundle.mjs";

describe("typebox prebundle", () => {
	let dir: string;
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "lunr-typebox-prebundle-"));
		await buildTypeboxPrebundle(join(dir, "typebox"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	// An SDK user or extension with its own typebox hands lunR schemas built by that copy.
	it("validates schemas across the installed and the prebuilt copy, both ways", async () => {
		const prebuilt = (subpath: string) => import(pathToFileURL(join(dir, "typebox", subpath)).href);
		const { Type: PrebuiltType } = await prebuilt("index.js");
		const { Compile: PrebuiltCompile } = await prebuilt("compile/index.js");
		const { Value: PrebuiltValue } = await prebuilt("value/index.js");
		expect(PrebuiltType).not.toBe(Type);

		const fromInstalled = Type.Object({ path: Type.String(), limit: Type.Optional(Type.Integer()) });
		expect(PrebuiltCompile(fromInstalled).Check({ path: "a" })).toBe(true);
		expect(PrebuiltCompile(fromInstalled).Check({ path: 1 })).toBe(false);
		expect(PrebuiltValue.Check(fromInstalled, { path: "a", limit: 2 })).toBe(true);
		expect(PrebuiltValue.Convert(fromInstalled, { path: "a", limit: "2" })).toEqual({ path: "a", limit: 2 });

		const fromPrebuilt = PrebuiltType.Object({
			path: PrebuiltType.String(),
			limit: PrebuiltType.Optional(PrebuiltType.Integer()),
		});
		expect(Compile(fromPrebuilt).Check({ path: "a" })).toBe(true);
		expect(Value.Check(fromPrebuilt, { limit: 1 })).toBe(false);
		expect(JSON.stringify(fromPrebuilt)).toBe(JSON.stringify(fromInstalled));
	});

	it("redirects imports of the same typebox version only", async () => {
		const stale = join(dir, "stale");
		cpSync(join(dir, "typebox"), stale, { recursive: true });
		const manifestPath = join(stale, "manifest.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "0.0.0" }),
		);
		const resolveAfterInstall = async (prebundleDir: string) => {
			const script = `
				const { installTypeboxPrebundle } = await import(${JSON.stringify(new URL("../src/core/typebox-prebundle.ts", import.meta.url).href)});
				installTypeboxPrebundle(${JSON.stringify(prebundleDir)});
				console.log(import.meta.resolve("typebox/compile"));
			`;
			const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
				cwd: fileURLToPath(new URL("..", import.meta.url)),
			});
			return stdout.trim();
		};
		expect(await resolveAfterInstall(join(dir, "typebox"))).toBe(
			pathToFileURL(join(dir, "typebox", "compile", "index.js")).href,
		);
		expect(await resolveAfterInstall(stale)).toMatch(/\/typebox\/build\/compile\/index\.mjs$/);
	});
});
