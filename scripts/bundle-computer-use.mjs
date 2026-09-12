import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("Usage: node scripts/bundle-computer-use.mjs <verified-archive-directory>");
const release = JSON.parse(await readFile(new URL("./computer-use-release.json", import.meta.url), "utf8"));
const destination = resolve("packages/coding-agent/native/computer-use");
await mkdir(destination, { recursive: true });
for (const artifact of release.artifacts) {
	await verifyComputerUseArchive(directory, artifact);
	await copyFile(resolve(directory, artifact.name), resolve(destination, artifact.name));
}
await copyFile(new URL("./computer-use-release.json", import.meta.url), resolve(destination, "release.json"));
console.log(`Bundled unchanged CuaDriver ${release.version} archives. No executable was run.`);
