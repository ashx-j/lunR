/**
 * The Node bundle ships typebox prebuilt in `dist/node-runtime/typebox/`: 9 entries, 9 shared chunks
 * and a manifest, written by scripts/build-typebox-prebundle.mjs. Installed, typebox is about 670
 * ESM files, and loading them cost about 170 ms per launch. `installTypeboxPrebundle()` runs in
 * cli-runtime.ts before anything imports typebox (scripts/build-node-runtime.mjs fails the build if
 * cli-runtime's static imports reach typebox). From then on, an import that resolves into the
 * installed `typebox` package at the manifest's version loads the prebuilt file instead: pi-ai,
 * pi-agent-core, the CLI bundle and extensions share one copy. Another typebox version resolves as
 * before, for all of them.
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
}

let installed = false;

/** Redirect imports of installed typebox to the prebuilt copy in `dir`. Does nothing if `dir` has none. */
export function installTypeboxPrebundle(dir: string): void {
	if (installed || typeof nodeModule.registerHooks !== "function") return;
	let manifest: TypeboxPrebundleManifest;
	try {
		manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	} catch {
		return;
	}
	const base = pathToFileURL(join(dir, "/")).href;
	const matchesByPackage = new Map<string, boolean>();
	const isPrebuiltPackage = (packageUrl: string): boolean => {
		let matches = matchesByPackage.get(packageUrl);
		if (matches === undefined) {
			try {
				const pkg = JSON.parse(readFileSync(new URL("package.json", packageUrl), "utf8"));
				matches = pkg.name === "typebox" && pkg.version === manifest.version;
			} catch {
				matches = false;
			}
			matchesByPackage.set(packageUrl, matches);
		}
		return matches;
	};
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			// Every resolve in the process passes here. Bare names, aliases and paths to typebox all
			// contain "typebox"; anything else returns before more work.
			if (!specifier.includes("typebox")) return nextResolve(specifier, context);
			const resolved = nextResolve(specifier, context);
			const at = resolved.url.lastIndexOf("/typebox/build/");
			if (at === -1) return resolved;
			const packageUrl = resolved.url.slice(0, at + "/typebox/".length);
			const file = manifest.files[resolved.url.slice(packageUrl.length + "build/".length)];
			if (!file || !isPrebuiltPackage(packageUrl)) return resolved;
			return { ...resolved, url: base + file, shortCircuit: true };
		},
	});
	installed = true;
}
