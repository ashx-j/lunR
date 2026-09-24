import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { assertStagedTarball } from "./remote-product-tarballs.mjs";

const name = "@ashx-j/lunr-ai";
const key = `node_modules/${name}`;

test("lockfile provenance resolves to the staged tarball, not just any local file", () => {
	const root = mkdtempSync(join(tmpdir(), "lunr-staged-tarball-"));
	try {
		const packs = join(root, "packs with spaces");
		const install = join(root, "install");
		mkdirSync(packs);
		mkdirSync(install);
		const archive = join(packs, "lunr-ai.tgz");
		writeFileSync(archive, "fixture");
		const alias = join(root, "packs-alias");
		symlinkSync(packs, alias, process.platform === "win32" ? "junction" : "dir");
		const lock = (resolved) => ({ packages: { [key]: { resolved } } });
		assertStagedTarball(lock(pathToFileURL(join(alias, "lunr-ai.tgz")).href), name, archive, install);
		assertStagedTarball(lock("file:../packs%20with%20spaces/lunr-ai.tgz"), name, archive, install);
		assert.throws(() => assertStagedTarball(lock("https://registry.npmjs.org/lunr-ai.tgz"), name, archive, install), /outside staged tarballs/);
		const other = join(root, "other.tgz");
		writeFileSync(other, "different fixture");
		assert.throws(() => assertStagedTarball(lock(pathToFileURL(other).href), name, archive, install), /did not resolve to its staged tarball/);
		assert.throws(() => assertStagedTarball({ packages: {} }, name, archive, install), /no resolved tarball/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
