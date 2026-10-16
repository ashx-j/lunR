import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Staging runs outside the repository, so copy both project and upstream notices. Standalone archives use the same step. */
export function stagePackageNotice(destination) {
	mkdirSync(destination, { recursive: true });
	copyFileSync(join(repoRoot, "LICENSE"), join(destination, "LICENSE"));
	copyFileSync(join(repoRoot, "THIRD_PARTY_NOTICES"), join(destination, "THIRD_PARTY_NOTICES"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [destination, ...extra] = process.argv.slice(2);
	if (!destination || extra.length) throw new Error("Usage: node scripts/distribution-assets.mjs <destination>");
	stagePackageNotice(resolve(destination));
}
