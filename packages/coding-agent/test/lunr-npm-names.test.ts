import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNoEarendil,
	DEV_WORKSPACE_TO_NPM,
	NPM_CLI_PACKAGE,
	NPM_DEV_CLI_PACKAGE,
	publishTagFor,
	rewritePackageJsonForNpm,
	rewriteWorkspaceSpecifiers,
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

	it("stages a separate dev CLI with exact prerelease dependencies", () => {
		const raw = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
		const version = "0.2.13-dev.12.1";
		const rewritten = rewritePackageJsonForNpm(raw, {
			packageNames: DEV_WORKSPACE_TO_NPM,
			version,
			workspaceDependencyVersion: version,
			bin: { "lunr-dev": "dist/dev-cli.js" },
			appName: "lunr-dev",
		});
		expect(rewritten.name).toBe(NPM_DEV_CLI_PACKAGE);
		expect(rewritten.version).toBe(version);
		expect(rewritten.bin).toEqual({ "lunr-dev": "dist/dev-cli.js" });
		expect(rewritten.piConfig).toEqual({ name: "lunr-dev", configDir: ".lunr" });
		expect(rewritten.dependencies["@ashx-j/lunr-ai"]).toBe(version);
		expect(rewritten.dependencies["@ashx-j/lunr-tui"]).toBe(version);
		expect(rewritten.dependencies["@ashx-j/lunr-agent"]).toBe(version);
		assertNoEarendil(rewritten);
	});

	it("assigns dev tags without touching stable latest tags", () => {
		expect(publishTagFor("@earendil-works/pi-ai", "stable")).toBeUndefined();
		expect(publishTagFor("@earendil-works/pi-ai", "dev")).toBe("dev");
		expect(publishTagFor("@earendil-works/pi-coding-agent", "dev")).toBe("latest");
		expect(() => publishTagFor("@earendil-works/pi-ai", "unknown")).toThrow(/unknown publish channel/);
	});

	it("rewrites compiled import specifiers", () => {
		const src = 'import { modelsAreEqual } from "@earendil-works/pi-ai";\nfrom "@earendil-works/pi-agent-core";';
		const out = rewriteWorkspaceSpecifiers(src);
		expect(out).toContain('from "@ashx-j/lunr-ai"');
		expect(out).toContain('from "@ashx-j/lunr-agent"');
		expect(out).not.toContain("@earendil-works");
		expect(rewriteWorkspaceSpecifiers('from "@earendil-works/pi-coding-agent"', DEV_WORKSPACE_TO_NPM)).toContain(
			'from "@ashx-j/lunr-dev"',
		);
	});

	it("refuses leftover @earendil-works strings", () => {
		expect(() => assertNoEarendil({ name: "@earendil-works/pi-ai" })).toThrow(/earendil-works/);
	});
});
