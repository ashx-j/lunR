import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNoEarendil,
	NPM_CLI_PACKAGE,
	rewritePackageJsonForNpm,
	WORKSPACE_TO_NPM,
} from "../../../scripts/lunr-npm-names.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("lunR npm publish names", () => {
	it("maps the CLI to @ashx-j/lunr", () => {
		expect(NPM_CLI_PACKAGE).toBe("@ashx-j/lunr");
		expect(WORKSPACE_TO_NPM["@earendil-works/pi-coding-agent"]).toBe("@ashx-j/lunr");
	});

	it("rewrites coding-agent package.json off @earendil-works", () => {
		const raw = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
		const rewritten = rewritePackageJsonForNpm(raw);
		expect(rewritten.name).toBe("@ashx-j/lunr");
		expect(rewritten.dependencies["@ashx-j/lunr-ai"]).toBeDefined();
		expect(rewritten.dependencies["@ashx-j/lunr-tui"]).toBeDefined();
		expect(rewritten.dependencies["@ashx-j/lunr-agent"]).toBeDefined();
		expect(rewritten.dependencies["@earendil-works/pi-ai"]).toBeUndefined();
		expect(rewritten.files).not.toContain("npm-shrinkwrap.json");
		expect(rewritten.scripts.prepublishOnly).toBeUndefined();
		assertNoEarendil(rewritten);
	});

	it("rewrites agent-core's pi-ai dependency", () => {
		const raw = JSON.parse(readFileSync(join(repoRoot, "packages/agent/package.json"), "utf8"));
		const rewritten = rewritePackageJsonForNpm(raw);
		expect(rewritten.name).toBe("@ashx-j/lunr-agent");
		expect(rewritten.dependencies["@ashx-j/lunr-ai"]).toBeDefined();
		assertNoEarendil(rewritten);
	});

	it("refuses leftover @earendil-works strings", () => {
		expect(() => assertNoEarendil({ name: "@earendil-works/pi-ai" })).toThrow(/earendil-works/);
	});
});
