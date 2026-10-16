import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stagePackageNotice } from "../../../scripts/distribution-assets.mjs";
import { rewritePackageJsonForNpm } from "../../../scripts/lunr-npm-names.mjs";

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

describe("distribution notices", () => {
	it.each(["ai", "tui", "agent", "coding-agent"])("includes both notices in the public %s npm package", (name) => {
		const directory = temporaryDirectory();
		stagePackageNotice(directory);
		const source = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, repository), "utf8"));
		writeFileSync(join(directory, "package.json"), JSON.stringify(rewritePackageJsonForNpm(source)));
		const output = execFileSync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["pack", "--dry-run", "--ignore-scripts", "--json"],
			{ cwd: directory, encoding: "utf8", shell: process.platform === "win32" },
		);
		const [packed] = Object.values(JSON.parse(output)) as { files: { path: string }[] }[];
		for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES"]) {
			expect(packed.files.map((file) => file.path)).toContain(notice);
			expect(readFileSync(join(directory, notice))).toEqual(readFileSync(new URL(notice, repository)));
		}
	});
});
