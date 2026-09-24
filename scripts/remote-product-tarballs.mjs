import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function assertStagedTarball(lock, name, archive, installDir) {
	const key = `node_modules/${name}`;
	const row = lock.packages[key];
	assert.ok(typeof row?.resolved === "string", `${name} has no resolved tarball at ${key}: ${JSON.stringify(row)}; matching entries: ${JSON.stringify(Object.keys(lock.packages).filter((path) => path.endsWith(`/${name}`)).slice(0, 8))}`);
	const url = new URL(row.resolved, pathToFileURL(`${installDir}${sep}`));
	assert.equal(url.protocol, "file:", `${name} resolved outside staged tarballs: ${row.resolved}`);
	assert.equal(realpathSync(fileURLToPath(url)), realpathSync(archive), `${name} did not resolve to its staged tarball: ${row.resolved}`);
}
