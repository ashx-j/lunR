import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/ai/vendor/hermes-claude-subscription-directsdk");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
for (const [path, expected] of Object.entries(manifest.upstreamFiles)) {
	if (path === "directsdk.py") continue;
	if (hash(path) !== expected) throw new Error(`Unrecorded upstream edit: ${path}`);
}
for (const [path, expected] of Object.entries({ ...manifest.patchedFiles, ...manifest.patches })) {
	if (hash(path) !== expected) throw new Error(`Unrecorded vendor patch: ${path}`);
}
console.log(`Verified pinned Claude Code vendor ${manifest.commit} and ${Object.keys(manifest.upstreamFiles).length} upstream hashes`);
