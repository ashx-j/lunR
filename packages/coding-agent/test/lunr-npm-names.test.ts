import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNoEarendil,
	assertPublishedEntryPointsExist,
	assertPublishedTreeHasNoEarendil,
	DEV_WORKSPACE_TO_NPM,
	NPM_CLI_PACKAGE,
	NPM_DEV_CLI_PACKAGE,
	publishTagFor,
	rewritePackageJsonForNpm,
	rewritePackageLockForNpm,
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
		expect(rewritten.files).toContain("npm-shrinkwrap.json");
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

	it("stages the dev CLI with exact dependencies and its own binary", () => {
		const raw = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
		const version = `${raw.version}-dev.10.1`;
		const rewritten = rewritePackageJsonForNpm(raw, { packageNames: DEV_WORKSPACE_TO_NPM, version });
		expect(rewritten.name).toBe(NPM_DEV_CLI_PACKAGE);
		expect(rewritten.version).toBe(version);
		expect(rewritten.bin).toEqual({ "lunr-dev": "dist/dev-cli.js" });
		expect(rewritten.piConfig).toEqual({ name: "lunr-dev", configDir: ".lunr" });
		expect(rewritten.dependencies["@ashx-j/lunr-ai"]).toBe(version);
		expect(rewritten.dependencies["@ashx-j/lunr-tui"]).toBe(version);
		expect(rewritten.dependencies["@ashx-j/lunr-agent"]).toBe(version);
		expect(rewritten.files).toContain("npm-shrinkwrap.json");
		expect(rewriteWorkspaceSpecifiers('from "@earendil-works/pi-coding-agent"', DEV_WORKSPACE_TO_NPM)).toBe(
			'from "@ashx-j/lunr-dev"',
		);
		assertNoEarendil(rewritten);
	});

	it.each(["npm-shrinkwrap.json", "install-lock/package-lock.json"])(
		"rewrites dev versions and tarball URLs in %s",
		(file) => {
			const raw = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent", file), "utf8"));
			const version = `${raw.version}-dev.10.1`;
			const rewritten = rewritePackageLockForNpm(raw, { packageNames: DEV_WORKSPACE_TO_NPM, version });
			expect(rewritten.version).toBe(version);
			expect(rewritten.packages[""].version).toBe(version);
			const cli = rewritten.packages[file === "npm-shrinkwrap.json" ? "" : "node_modules/@ashx-j/lunr-dev"];
			expect(cli.bin).toEqual({ "lunr-dev": "dist/dev-cli.js" });
			for (const name of ["@ashx-j/lunr-ai", "@ashx-j/lunr-tui", "@ashx-j/lunr-agent"]) {
				expect(cli.dependencies[name]).toBe(version);
				expect(rewritten.packages[`node_modules/${name}`].version).toBe(version);
				expect(rewritten.packages[`node_modules/${name}`].resolved).toBe(
					`https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${version}.tgz`,
				);
			}
			assertNoEarendil(rewritten);
			expect(JSON.stringify(raw)).toContain("@earendil-works/");
		},
	);

	it("keeps stable latest tags untouched by dev publication", () => {
		expect(publishTagFor("@earendil-works/pi-ai", "stable")).toBe("latest");
		expect(publishTagFor("@earendil-works/pi-ai", "dev")).toBe("dev");
		expect(publishTagFor("@earendil-works/pi-coding-agent", "dev")).toBe("latest");
		expect(() => publishTagFor("@earendil-works/pi-ai", "unknown")).toThrow(/unknown publish channel/i);
	});

	it("rewrites compiled import specifiers", () => {
		const src = 'import { modelsAreEqual } from "@earendil-works/pi-ai";\nfrom "@earendil-works/pi-agent-core";';
		const out = rewriteWorkspaceSpecifiers(src);
		expect(out).toContain('from "@ashx-j/lunr-ai"');
		expect(out).toContain('from "@ashx-j/lunr-agent"');
		expect(out).not.toContain("@earendil-works");
	});

	it("refuses leftover @earendil-works strings", () => {
		expect(() => assertNoEarendil({ name: "@earendil-works/pi-ai" })).toThrow(/earendil-works/);
	});

	it("scans bundled publish chunks even when dist/main.js is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-publish-scan-"));
		try {
			mkdirSync(join(root, "dist", "node-runtime"), { recursive: true });
			writeFileSync(join(root, "dist", "node-runtime", "chunk.js"), 'import "@earendil-works/pi-ai";\n');
			expect(() => assertPublishedTreeHasNoEarendil(root, "test package")).toThrow(/node-runtime.*earendil-works/i);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses missing staged package entry points", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-publish-entry-"));
		try {
			mkdirSync(join(root, "dist"), { recursive: true });
			expect(() =>
				assertPublishedEntryPointsExist(
					root,
					{ main: "./dist/node-runtime/index.js", exports: { "./rpc-entry": "./dist/rpc.js" } },
					"test package",
				),
			).toThrow(/node-runtime\/index\.js does not exist/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts populated wildcard entry points", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-publish-wildcard-"));
		try {
			mkdirSync(join(root, "dist", "catalog"), { recursive: true });
			writeFileSync(join(root, "dist", "catalog", "index.js"), "export {};\n");
			expect(() =>
				assertPublishedEntryPointsExist(
					root,
					{ exports: { "./catalog/*": { import: "./dist/catalog/*.js" } } },
					"test package",
				),
			).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts a clean staged publish tree", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-publish-clean-"));
		try {
			mkdirSync(join(root, "dist", "node-runtime"), { recursive: true });
			writeFileSync(join(root, "dist", "node-runtime", "chunk.js"), 'import "@ashx-j/lunr-ai";\n');
			expect(() => assertPublishedTreeHasNoEarendil(root, "test package")).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
