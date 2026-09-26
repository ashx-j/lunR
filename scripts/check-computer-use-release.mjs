import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function verifyComputerUseArchive(directory, artifact) {
	if (
		typeof artifact.name !== "string" ||
		artifact.name !== basename(artifact.name) ||
		artifact.name.includes("\\") ||
		!/^cua-driver-rs-[a-zA-Z0-9._-]+\.(zip|tar\.gz)$/.test(artifact.name) ||
		!Number.isSafeInteger(artifact.bytes) ||
		artifact.bytes <= 0 ||
		!/^([a-f0-9]{64})$/.test(artifact.sha256)
	) {
		throw new Error("Invalid Cua release artifact metadata");
	}
	const path = resolve(directory, artifact.name);
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${artifact.name}: expected a regular archive`);
	if (info.size !== artifact.bytes) throw new Error(`${artifact.name}: size mismatch`);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	const actual = hash.digest("hex");
	if (actual !== artifact.sha256) throw new Error(`${artifact.name}: SHA-256 mismatch`);
	return { name: artifact.name, bytes: info.size, sha256: actual };
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length !== 1) throw new Error("Usage: node scripts/check-computer-use-release.mjs <archive-directory> | --production");
	const release = JSON.parse(await readFile(new URL("./computer-use-release.json", import.meta.url), "utf8"));
	if (args[0] === "--production") {
		if (release.approval !== "production-approved") throw new Error("Computer-use runtime has development-only approval. Production publication is blocked.");
		return;
	}
	for (const artifact of release.artifacts) {
		console.log(JSON.stringify(await verifyComputerUseArchive(args[0], artifact)));
	}
	console.log(`Verified archive bytes for CuaDriver ${release.version}. Approval: ${release.approval}.`);
	console.log("Checksums do not establish signing, installation, MCP interoperability, or desktop acceptance.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
