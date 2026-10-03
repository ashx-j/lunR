import { existsSync, globSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stagePackageNotice, stageStandaloneAssets } from "../../../scripts/distribution-assets.mjs";
import { getClaudeCodeWorkerPath } from "../../ai/src/utils/claude-code-assets.ts";

const repository = new URL("../../../", import.meta.url);
const directories: string[] = [];
function temporaryDirectory() {
	const directory = mkdtempSync(join(tmpdir(), "lunr-distribution-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("physical distribution assets", () => {
	it.each(["file:///$bunfs/root/probe.js", "file:///~BUN/root/probe.js", "file:///%7EBUN/root/probe.js"])(
		"resolves both workers and every declared helper after relocation, %s",
		(moduleUrl) => {
			const original = temporaryDirectory();
			stageStandaloneAssets(original);
			writeFileSync(join(original, "lunr"), "inert executable");
			const relocated = `${original}-relocated`;
			directories.push(relocated);
			renameSync(original, relocated);
			for (const worker of ["lunr_bridge.py", "lunr_setup_bridge.py"] as const) {
				const path = getClaudeCodeWorkerPath(worker, { moduleUrl, execPath: join(relocated, "lunr") });
				expect(path).toBe(join(relocated, "vendor/hermes-claude-subscription-directsdk", worker));
				expect(existsSync(path)).toBe(true);
			}
			const aiDirectory = new URL("packages/ai/", repository);
			const manifest = JSON.parse(readFileSync(new URL("package.json", aiDirectory), "utf8"));
			for (const pattern of manifest.files.filter((file: string) => file.startsWith("vendor/"))) {
				for (const file of globSync(pattern, { cwd: aiDirectory })) {
					expect(readFileSync(join(relocated, file))).toEqual(readFileSync(new URL(file, aiDirectory)));
				}
			}
			expect(readFileSync(join(relocated, "LICENSE"), "utf8")).toContain("2025 Mario Zechner");
			expect(readFileSync(join(relocated, "LICENSE"), "utf8")).toContain("2026 ashx-j");
		},
	);

	it("resolves source and npm layouts independently of cwd", () => {
		const directory = temporaryDirectory();
		stageStandaloneAssets(directory);
		for (const layout of ["src", "dist"]) {
			const path = getClaudeCodeWorkerPath("lunr_bridge.py", {
				moduleUrl: pathToFileURL(join(directory, layout, "utils/claude-code-assets.js")).href,
				execPath: "/unrelated/node",
			});
			expect(path).toBe(join(directory, "vendor/hermes-claude-subscription-directsdk/lunr_bridge.py"));
		}
	});

	it("rejects a missing physical worker", () => {
		expect(() =>
			getClaudeCodeWorkerPath("lunr_bridge.py", {
				moduleUrl: "file:///$bunfs/root/probe.js",
				execPath: join(temporaryDirectory(), "lunr"),
			}),
		).toThrow(/extract the complete standalone archive/);
	});

	it("stages the complete MIT notice for npm package copies", () => {
		const directory = temporaryDirectory();
		stagePackageNotice(directory);
		expect(readFileSync(join(directory, "LICENSE"))).toEqual(readFileSync(new URL("LICENSE", repository)));
	});
});
