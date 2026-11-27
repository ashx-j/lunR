import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * typebox as installed is about 670 ESM files. Prebuild its subpath exports into `outDir` with
 * shared chunks, plus a manifest.json that core/typebox-prebundle.ts reads to redirect imports of
 * the same typebox version there. Builds coding-agent's typebox.
 */
export async function buildTypeboxPrebundle(outDir) {
	const typeboxBuild = dirname(createRequire(join(root, "packages/coding-agent/package.json")).resolve("typebox"));
	const typeboxPackage = JSON.parse(readFileSync(join(typeboxBuild, "..", "package.json"), "utf8"));
	const exportsToTarget = Object.fromEntries(
		Object.entries(typeboxPackage.exports).map(([subpath, target]) => [
			subpath,
			posix.relative("./build", typeof target === "string" ? target : target.import),
		]),
	);
	const result = await build({
		absWorkingDir: root,
		entryPoints: Object.values(exportsToTarget).map((target) => join(typeboxBuild, target)),
		outdir: outDir,
		outbase: typeboxBuild,
		entryNames: "[dir]/[name]",
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "node",
		target: "node22",
		minifySyntax: true,
		metafile: true,
		logLevel: "warning",
	});
	const files = {};
	for (const [output, meta] of Object.entries(result.metafile.outputs)) {
		if (!meta.entryPoint) continue;
		const target = relative(typeboxBuild, resolve(root, meta.entryPoint)).replaceAll("\\", "/");
		files[target] = relative(outDir, resolve(root, output)).replaceAll("\\", "/");
	}
	writeFileSync(
		join(outDir, "manifest.json"),
		`${JSON.stringify({ version: typeboxPackage.version, files }, null, "\t")}\n`,
	);
}

/**
 * The chain of output files by which `entry`'s static imports reach an external typebox import, or
 * undefined. cli-runtime must not have one: its static imports run before it installs the redirect,
 * so they would load the installed typebox next to the prebuilt one.
 */
export function findStaticTypeboxImport(metafile, entry) {
	const seen = new Set();
	const visit = (output, chain) => {
		if (seen.has(output)) return undefined;
		seen.add(output);
		for (const imported of metafile.outputs[output]?.imports ?? []) {
			if (imported.kind !== "import-statement") continue;
			if (imported.external) {
				if (/^(@sinclair\/)?typebox(\/|$)/.test(imported.path)) return [...chain, output, imported.path];
				continue;
			}
			const found = visit(imported.path, [...chain, output]);
			if (found) return found;
		}
		return undefined;
	};
	return visit(entry, []);
}
