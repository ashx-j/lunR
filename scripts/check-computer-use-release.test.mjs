import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "lunr-cua-archive-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const data = Buffer.from("opaque signed archive fixture");
	const artifact = {
		name: "cua-driver-rs-0.28.1-windows-x86_64-binary.zip",
		bytes: data.length,
		sha256: createHash("sha256").update(data).digest("hex"),
	};
	await writeFile(join(directory, artifact.name), data);
	return { directory, artifact, data };
}

test("validates exact opaque bytes without extracting or executing the payload", async (t) => {
	const { directory, artifact } = await fixture(t);
	assert.deepEqual(await verifyComputerUseArchive(directory, artifact), artifact);
});

test("rejects same-length tampering and truncated downloads", async (t) => {
	const { directory, artifact, data } = await fixture(t);
	data[0] ^= 1;
	await writeFile(join(directory, artifact.name), data);
	await assert.rejects(verifyComputerUseArchive(directory, artifact), /SHA-256 mismatch/);
	await writeFile(join(directory, artifact.name), data.subarray(1));
	await assert.rejects(verifyComputerUseArchive(directory, artifact), /size mismatch/);
});

test("rejects absent payloads rather than downloading during validation", async (t) => {
	const { directory, artifact } = await fixture(t);
	await rm(join(directory, artifact.name));
	await assert.rejects(verifyComputerUseArchive(directory, artifact), { code: "ENOENT" });
});

test("rejects unsafe archive names and invalid checksum metadata", async (t) => {
	const { directory, artifact } = await fixture(t);
	for (const name of ["../archive.zip", "..\\archive.zip", "/archive.zip", "C:\\archive.zip", "archive.exe"]) {
		await assert.rejects(verifyComputerUseArchive(directory, { ...artifact, name }), /Invalid/);
	}
	await assert.rejects(verifyComputerUseArchive(directory, { ...artifact, sha256: "abc" }), /Invalid/);
	await assert.rejects(verifyComputerUseArchive(directory, { ...artifact, bytes: -1 }), /Invalid/);
});
