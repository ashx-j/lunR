/**
 * The Node bundle ships typebox prebuilt in `dist/node-runtime/typebox/` (a dozen files, built by
 * scripts/build-node-runtime.mjs). Installed, typebox is about 670 ESM files, and loading them cost
 * about 160 ms per launch. `installTypeboxPrebundle()` runs in cli-runtime.ts before anything
 * imports typebox. From then on, an import that resolves to an installed typebox of the prebuilt
 * version loads the prebuilt file instead: pi-ai, pi-agent-core, the CLI bundle and extensions
 * share one copy. Another typebox version resolves as before.
 */
import { readFileSync } from "node:fs";
// A namespace import: the Bun binary bundles this module too, and Bun need not have registerHooks.
import * as nodeModule from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface TypeboxPrebundleManifest {
	version: string;
	/** Export target relative to the package's `build/` directory, to the prebuilt file. */
	files: Record<string, string>;
	/** Subpath export (`"."`, `"./compile"`, ...) to the prebuilt file. */
	exports: Record<string, string>;
}

let installedDir: string | undefined;
let manifest: TypeboxPrebundleManifest | undefined;

/** Redirect imports of installed typebox to the prebuilt copy in `dir`. Does nothing if `dir` has none. */
export function installTypeboxPrebundle(dir: string): void {
	if (installedDir !== undefined || typeof nodeModule.registerHooks !== "function") return;
	let loaded: TypeboxPrebundleManifest;
	try {
		loaded = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	} catch {
		return;
	}
	const base = pathToFileURL(join(dir, "/")).href;
	const versionByPackage = new Map<string, boolean>();
	const matchesVersion = (packageUrl: string): boolean => {
		let matches = versionByPackage.get(packageUrl);
		if (matches === undefined) {
			try {
				const pkg = JSON.parse(readFileSync(new URL("package.json", packageUrl), "utf8"));
				matches = pkg.version === loaded.version;
			} catch {
				matches = false;
			}
			versionByPackage.set(packageUrl, matches);
		}
		return matches;
	};
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			const at = resolved.url.lastIndexOf("/typebox/build/");
			if (at === -1) return resolved;
			const packageUrl = resolved.url.slice(0, at + "/typebox/".length);
			const file = loaded.files[resolved.url.slice(packageUrl.length + "build/".length)];
			if (!file || !matchesVersion(packageUrl)) return resolved;
			return { ...resolved, url: base + file, shortCircuit: true };
		},
	});
	installedDir = dir;
	manifest = loaded;
}

/** Path of the prebuilt file for a typebox subpath export (`"."`, `"./compile"`), once installed. */
export function getTypeboxPrebundleEntry(subpath: string): string | undefined {
	const file = manifest?.exports[subpath];
	return installedDir && file ? join(installedDir, file) : undefined;
}
