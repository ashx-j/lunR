import { copyFileSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Package staging runs outside the repository, so npm cannot inherit the root MIT notice. */
export function stagePackageNotice(destination) {
	mkdirSync(destination, { recursive: true });
	copyFileSync(join(repoRoot, "LICENSE"), join(destination, "LICENSE"));
}

/** Ship the same licensed Python/helper files as the AI npm package, outside Bun's virtual filesystem. */
export function stageStandaloneAssets(destination) {
	stagePackageNotice(destination);
	const aiDirectory = join(repoRoot, "packages", "ai");
	const manifest = JSON.parse(readFileSync(join(aiDirectory, "package.json"), "utf8"));
	for (const pattern of manifest.files.filter((path) => path.startsWith("vendor/"))) {
		const files = globSync(pattern, { cwd: aiDirectory });
		if (!files.length) throw new Error(`Missing standalone asset: ${pattern}`);
		for (const file of files) {
			const target = join(destination, file);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(aiDirectory, file), target);
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [destination, ...extra] = process.argv.slice(2);
	if (!destination || extra.length) throw new Error("Usage: node scripts/distribution-assets.mjs <destination>");
	stageStandaloneAssets(resolve(destination));
}
