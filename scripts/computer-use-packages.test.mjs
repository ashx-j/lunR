import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addPayloadDependencies, copyStandalonePayload, payloadManifest, release, stagePayloadPackages } from "./computer-use-packages.mjs";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";
import { rewritePackageLockForNpm } from "./lunr-npm-names.mjs";

test("payload manifests select one OS/CPU, contain no scripts and follow the CLI release version", () => {
	for (const artifact of release.artifacts) {
		const manifest = payloadManifest(artifact, "0.9.0-test.1");
		assert.deepEqual(manifest.os, [artifact.platform]);
		assert.deepEqual(manifest.cpu, [artifact.arch]);
		assert.equal(manifest.version, "0.9.0-test.1");
		assert.equal(manifest.scripts, undefined);
		assert.deepEqual(manifest.files, [artifact.name, "LICENSE.md"]);
	}
});

test("release staging injects exact optional dependencies into shrinkwrap and installer ownership", () => {
	for (const owner of ["", "node_modules/@ashx-j/lunr"]) {
		const manifest = { version: "0.9.0", optionalDependencies: { existing: "1.0.0" } };
		const lock = { packages: { [owner]: { version: manifest.version } } };
		addPayloadDependencies(manifest, lock, owner);
		assert.deepEqual(lock.packages[owner].optionalDependencies, manifest.optionalDependencies);
		for (const artifact of release.artifacts) {
			assert.equal(manifest.optionalDependencies[artifact.packageName], "0.9.0");
			assert.deepEqual(lock.packages[`node_modules/${artifact.packageName}`].os, [artifact.platform]);
			assert.equal(lock.packages[`node_modules/${artifact.packageName}`].optional, true);
			assert.match(lock.packages[`node_modules/${artifact.packageName}`].resolved, /-0\.9\.0\.tgz$/);
		}
	}
	assert.throws(() => addPayloadDependencies({ version: "0.9.0" }, { packages: {} }), /Missing/);
});

test("public lock rewriting updates tarball basenames as well as scoped names", () => {
	const original = { packages: { "node_modules/@earendil-works/pi-tui": { version: "0.9.0", resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.9.0.tgz", integrity: "workspace-identity" } } };
	const rewritten = rewritePackageLockForNpm(original);
	assert.equal(rewritten.packages["node_modules/@ashx-j/lunr-tui"].resolved, "https://registry.npmjs.org/@ashx-j/lunr-tui/-/lunr-tui-0.9.0.tgz");
	assert.equal(rewritten.packages["node_modules/@ashx-j/lunr-tui"].integrity, undefined);
	assert.ok(original.packages["node_modules/@earendil-works/pi-tui"]);
});

test("staged packages and standalone assets preserve opaque approved archives", async () => {
	const root = await mkdtemp(join(tmpdir(), "lunr-payload-test-"));
	try {
		const packages = await stagePayloadPackages(join(root, "packages"), "0.9.0");
		for (const { directory, artifact } of packages) {
			assert.deepEqual((await readdir(directory)).sort(), ["LICENSE.md", artifact.name, "package.json"].sort());
			await verifyComputerUseArchive(directory, artifact);
			assert.equal(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).name, artifact.packageName);
			const standalone = join(root, `${artifact.platform}-${artifact.arch}`);
			assert.equal(await copyStandalonePayload(standalone, artifact.platform, artifact.arch), true);
			const assets = join(standalone, "native", "computer-use");
			assert.deepEqual((await readdir(assets)).sort(), ["LICENSE.md", artifact.name, "release.json"].sort());
			await verifyComputerUseArchive(assets, artifact);
		}
		assert.equal(await copyStandalonePayload(join(root, "unsupported"), "linux", "x64"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
