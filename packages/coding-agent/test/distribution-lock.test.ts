import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	buildDistributionGraph,
	resolveDependencyPath,
	validateDependencyEdges,
} from "../../../scripts/distribution-lock-graph.mjs";

describe("published dependency resolution", () => {
	it("resolves exact direct versions and preserves the source Zod split", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const { packages } = JSON.parse(readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8"));
		expect(validateDependencyEdges(packages)).toEqual([]);
		for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
			if (name.startsWith("@earendil-works/")) continue;
			const expected = String(version).replace(/^npm:.*@/, "");
			expect(packages[resolveDependencyPath(packages, name, "")].version, name).toBe(expected);
		}
		expect(packages[resolveDependencyPath(packages, "zod", "")].version).toBe("4.4.3");
		for (const name of ["@mistralai/mistralai", "@modelcontextprotocol/sdk"]) {
			expect(packages[resolveDependencyPath(packages, "zod", `node_modules/${name}`)].version).toBe("3.25.76");
		}
		expect(
			Object.values(packages).filter((entry) => entry && typeof entry === "object" && "os" in entry),
		).not.toHaveLength(0);
	});

	it("keeps workspace-local dependencies and their nested transitive versions", () => {
		const root = { dependencies: { workspace: "1.0.0", zod: "4.4.3" } };
		const sources = {
			"packages/cli/node_modules/zod": { version: "4.4.3" },
			"packages/ai/node_modules/helper": { version: "2.0.0", dependencies: { zod: "3.25.76" } },
			"packages/ai/node_modules/helper/node_modules/zod": { version: "3.25.76" },
			"node_modules/helper": { version: "1.0.0" },
		};
		const workspaces = new Map([
			["workspace", { lockPath: "packages/ai", entry: { version: "1.0.0", dependencies: { helper: "2.0.0" } } }],
		]);
		const packages = buildDistributionGraph(sources, root, "packages/cli", workspaces);
		expect(validateDependencyEdges(packages)).toEqual([]);
		const helper = resolveDependencyPath(packages, "helper", "node_modules/workspace");
		expect(packages[helper].version).toBe("2.0.0");
		expect(packages[resolveDependencyPath(packages, "zod", helper)].version).toBe("3.25.76");
		expect(packages[resolveDependencyPath(packages, "zod", "")].version).toBe("4.4.3");
	});

	it("rejects a dependency present only under a sibling package", () => {
		const packages = {
			"": { dependencies: { zod: "4.4.3" } },
			"node_modules/sibling/node_modules/zod": { version: "4.4.3" },
		};
		expect(validateDependencyEdges(packages)).toEqual(["Cannot resolve zod from root"]);
	});

	it("reuses a reachable nested package when a conflicting version has a dependency cycle", () => {
		const packages = buildDistributionGraph(
			{
				"packages/cli/node_modules/helper": { version: "2.0.0" },
				"node_modules/helper": { version: "1.0.0", dependencies: { helper: "1.0.0" } },
			},
			{ dependencies: { helper: "2.0.0", workspace: "1.0.0" } },
			"packages/cli",
			new Map([
				["workspace", { lockPath: "packages/ai", entry: { version: "1.0.0", dependencies: { helper: "1.0.0" } } }],
			]),
		);
		expect(validateDependencyEdges(packages)).toEqual([]);
		expect(Object.keys(packages)).toHaveLength(4);
	});

	it("rejects incompatible versions, including npm aliases", () => {
		const packages = {
			"": { dependencies: { zod: "4.4.3", alias: "npm:typebox@1.1.38" } },
			"node_modules/zod": { version: "3.25.76" },
			"node_modules/alias": { version: "1.0.0" },
		};
		expect(validateDependencyEdges(packages)).toEqual([
			"root dependency zod@4.4.3 resolves to 3.25.76",
			"root dependency alias@npm:typebox@1.1.38 resolves to 1.0.0",
		]);
	});

	it("validates required and present optional peers but permits absent optional peers", () => {
		const packages = {
			"": {},
			"node_modules/library": {
				version: "1.0.0",
				peerDependencies: { zod: "^3.25", absent: "1.0.0" },
				peerDependenciesMeta: { zod: { optional: true }, absent: { optional: true } },
			},
			"node_modules/zod": { version: "4.4.3" },
		};
		expect(validateDependencyEdges(packages)).toEqual([
			"node_modules/library dependency zod@^3.25 resolves to 4.4.3",
		]);
	});
});
