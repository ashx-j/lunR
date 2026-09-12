import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/download-computer-use-release.mjs <destination>");
const release = JSON.parse(await readFile(new URL("./computer-use-release.json", import.meta.url), "utf8"));
await mkdir(directory, { recursive: true });
for (const artifact of release.artifacts) {
	const response = await fetch(`${release.repository}/releases/download/${release.tag}/${artifact.name}`, { signal: AbortSignal.timeout(120000) });
	if (!response.ok) throw new Error(`${artifact.name}: HTTP ${response.status}`);
	await writeFile(resolve(directory, artifact.name), new Uint8Array(await response.arrayBuffer()), { flag: "wx" });
	await verifyComputerUseArchive(directory, artifact);
}
console.log(`Downloaded and verified CuaDriver ${release.version}. This is maintainer packaging, not runtime installation.`);
