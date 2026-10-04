import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildDistributionGraph, validateDependencyEdges } from "./distribution-lock-graph.mjs";

test("fresh offline npm ci installs the root and nested Zod versions from the generated graph", (t) => {
	const root = mkdtempSync(join(tmpdir(), "lunr-lock-install-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const env = {
		PATH: process.env.PATH,
		...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT } : {}),
		HOME: root,
		USERPROFILE: root,
		npm_config_cache: join(root, "cache"),
		npm_config_offline: "true",
		npm_config_update_notifier: "false",
	};
	const npm = (args, cwd) => {
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
			cwd, env, encoding: "utf8", shell: process.platform === "win32", timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr + result.stdout);
		return result.stdout;
	};
	const pack = (directory, manifest) => {
		const source = join(root, directory);
		mkdirSync(source);
		writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
		const info = Object.values(JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], source)))[0];
		return { ...manifest, resolved: `file:${join(root, info.filename)}` };
	};
	const zod3 = pack("zod3", { name: "zod", version: "3.25.76" });
	const zod4 = pack("zod4", { name: "zod", version: "4.4.3" });
	const consumer = pack("consumer", {
		name: "lunr-lock-fixture-consumer", version: "1.0.0", dependencies: { zod: "^3.25.76" },
	});
	const manifest = {
		name: "lunr-lock-fixture", version: "1.0.0", private: true,
		dependencies: { zod: "4.4.3", "lunr-lock-fixture-consumer": "1.0.0" },
	};
	const packages = buildDistributionGraph({
		"packages/cli/node_modules/zod": zod4,
		"node_modules/zod": zod3,
		"node_modules/lunr-lock-fixture-consumer": consumer,
	}, manifest, "packages/cli", new Map());
	assert.deepEqual(validateDependencyEdges(packages), []);
	const installation = join(root, "installation");
	mkdirSync(installation);
	writeFileSync(join(installation, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(installation, "npm-shrinkwrap.json"), JSON.stringify({
		name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages,
	}));
	npm(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], installation);
	const require = createRequire(join(installation, "package.json"));
	assert.equal(require("zod/package.json").version, "4.4.3");
	const consumerRequire = createRequire(require.resolve("lunr-lock-fixture-consumer/package.json"));
	assert.equal(consumerRequire("zod/package.json").version, "3.25.76");
});
