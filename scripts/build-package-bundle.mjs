// Usage: node scripts/build-package-bundle.mjs <package dir>...
//
// Bundles a workspace package's compiled `dist/` into `dist/bundle/`: one esbuild build with code
// splitting, so the CLI, extensions and SDK users all resolve the same few files and share one copy
// of the package's modules. npm dependencies and the other workspace packages stay external. Types
// stay in `dist/*.d.ts`; the package's `exports` point `import` at dist/bundle/.
// coding-agent's build runs it for pi-tui, pi-ai and pi-agent-core first, so every build path that
// compiles them with tsgo (root build, CI, release, binary) ends with fresh bundles. Never run
// `npm run build` in packages/ai for it (catalog drift).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every entry is a chunk boundary: the more entries, the more files a launch loads. So only the
 * files callers import at startup are entries: the exact (non-wildcard) exports, `entries` and
 * `extraEntries`. `extraEntries` are files the package imports through a computed specifier, which
 * esbuild cannot follow. Every other file a wildcard export matches gets a small shim that reads
 * its module from one barrel entry (`wildcards.js`) of the same build, so a deep import still gets
 * the same module instances.
 *
 * `moduleUrl` is what a module's `import.meta.url` becomes: "bundle" mirrors its dist path inside
 * dist/bundle/, so computed relative imports land on bundle entries; "original" keeps its dist
 * path, for code that finds files next to dist (pi-tui's native helpers in ../native).
 */
const PACKAGES = {
	"@earendil-works/pi-ai": {
		entries: ["catalog/*.js", "providers/all.js", "providers/github-copilot.js"],
		extraEntries: ["auth/oauth/*.js", "api/anthropic-claude-code-bridge.js", "api/bedrock-converse-stream.js"],
		moduleUrl: "bundle",
	},
	"@earendil-works/pi-agent-core": { entries: [], extraEntries: [], moduleUrl: "bundle" },
	"@earendil-works/pi-tui": { entries: [], extraEntries: [], moduleUrl: "original" },
};

const BUNDLE_PREFIX = "./dist/bundle/";
const BARREL = "lunr-bundle-wildcards";

function listFiles(dir, base = dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "bundle" && dir === base ? [] : listFiles(path, base);
		return [relative(base, path).replaceAll("\\", "/")];
	});
}

/** The `import` targets of a package's exports and main, relative to dist/bundle/. */
function bundleTargets(pkg) {
	const targets = [];
	const collect = (value) => {
		if (typeof value === "string") targets.push(value);
		else if (value && typeof value === "object") collect(value.import ?? value.default);
	};
	for (const value of Object.values(pkg.exports ?? {})) collect(value);
	if (pkg.main) targets.push(pkg.main.startsWith("./") ? pkg.main : `./${pkg.main}`);
	return [...new Set(targets.filter((target) => target.startsWith(BUNDLE_PREFIX)))].map((target) =>
		target.slice(BUNDLE_PREFIX.length),
	);
}

/** Expand `a/*.js`-style patterns (where `*` may span directories) against the compiled files. */
function expand(patterns, files) {
	return patterns.flatMap((pattern) => {
		const star = pattern.indexOf("*");
		if (star === -1) return files.includes(pattern) ? [pattern] : [];
		const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
		return files.filter((file) => file.startsWith(prefix) && file.endsWith(suffix));
	});
}

const relativeImport = (from, to) => {
	const path = posix.relative(posix.dirname(from), to);
	return path.startsWith(".") ? path : `./${path}`;
};

export async function buildPackageBundle(packageDir) {
	const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const config = PACKAGES[pkg.name];
	if (!config) throw new Error(`${pkg.name} has no bundle config`);
	const dist = join(packageDir, "dist");
	const outdir = join(dist, "bundle");
	rmSync(outdir, { recursive: true, force: true });
	const files = listFiles(dist).filter((file) => file.endsWith(".js"));
	const targets = bundleTargets(pkg);
	const exact = targets.filter((target) => !target.includes("*"));
	const entries = [...new Set(expand([...exact, ...config.entries, ...config.extraEntries], files))];
	if (entries.length === 0) throw new Error(`${pkg.name}: no exports point into ${BUNDLE_PREFIX}`);
	const wildcards = targets.filter((target) => target.includes("*"));
	const shimmed = [...new Set(expand(wildcards, files))].filter((file) => !entries.includes(file));

	const common = {
		absWorkingDir: root,
		outdir,
		outbase: dist,
		entryNames: "[dir]/[name]",
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "node",
		target: "node22",
		packages: "external",
		external: ["@earendil-works/*"],
		tsconfigRaw: {},
		minifySyntax: true,
		metafile: true,
		logLevel: "warning",
	};

	// The export names of each shimmed module, from a build that writes nothing.
	const exportNames = new Map();
	if (shimmed.length > 0) {
		const probe = await build({ ...common, entryPoints: shimmed.map((file) => join(dist, file)), write: false });
		for (const meta of Object.values(probe.metafile.outputs)) {
			if (!meta.entryPoint) continue;
			exportNames.set(relative(dist, resolve(root, meta.entryPoint)).replaceAll("\\", "/"), meta.exports);
		}
	}

	const result = await build({
		...common,
		entryPoints: [
			...entries.map((entry) => join(dist, entry)),
			...(shimmed.length > 0 ? [{ in: BARREL, out: "wildcards" }] : []),
		],
		chunkNames: "chunks/[name]-[hash]",
		plugins: [
			{
				name: "wildcard-barrel",
				setup(builder) {
					builder.onResolve({ filter: new RegExp(`^${BARREL}$`) }, () => ({ path: BARREL, namespace: BARREL }));
					builder.onLoad({ filter: /.*/, namespace: BARREL }, () => ({
						contents: shimmed.map((file, i) => `export * as m${i} from ${JSON.stringify(`./${file}`)};`).join("\n"),
						resolveDir: dist,
						loader: "js",
					}));
				},
			},
			{
				name: "module-urls",
				setup(builder) {
					builder.onLoad({ filter: /\.js$/ }, (args) => {
						const file = relative(dist, args.path).replaceAll("\\", "/");
						if (file.startsWith("..")) return undefined;
						const contents = readFileSync(args.path, "utf8");
						if (!contents.includes("import.meta.url")) return { contents, loader: "js" };
						// Resolved per output file below, once esbuild has placed the module.
						const path = config.moduleUrl === "bundle" ? file : `../${file}`;
						return {
							contents: contents.replaceAll("import.meta.url", `__lunrModuleUrl(${JSON.stringify(path)})`),
							loader: "js",
						};
					});
				},
			},
		],
	});
	for (const output of Object.keys(result.metafile.outputs)) {
		if (!output.endsWith(".js")) continue;
		const path = resolve(root, output);
		const contents = readFileSync(path, "utf8");
		if (!contents.includes("__lunrModuleUrl(")) continue;
		const toRoot = posix.relative(dirname(relative(outdir, path)).replaceAll("\\", "/"), ".") || ".";
		const helper = `const __lunrModuleUrl = (path) => new URL(${JSON.stringify(`${toRoot}/`)} + path, import.meta.url).href;\n`;
		writeFileSync(path, helper + contents);
	}
	// A shim re-exports one module's names from the barrel's namespace for it. The values are read
	// once, so a shimmed module's `export let` would not update through the shim.
	shimmed.forEach((file, i) => {
		const names = exportNames.get(file) ?? [];
		const named = names.filter((name) => name !== "default");
		if (named.includes("wildcard")) throw new Error(`${file} exports "wildcard", which its shim uses`);
		const lines = [`import { m${i} as wildcard } from ${JSON.stringify(relativeImport(file, "wildcards.js"))};`];
		if (named.length > 0) lines.push(`export const { ${named.join(", ")} } = wildcard;`);
		if (names.includes("default")) lines.push("export default wildcard.default;");
		mkdirSync(dirname(join(outdir, file)), { recursive: true });
		writeFileSync(join(outdir, file), `${lines.join("\n")}\n`);
	});
	return { entries: entries.length, shims: shimmed.length, outputs: Object.keys(result.metafile.outputs).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	for (const arg of process.argv.slice(2)) {
		const packageDir = resolve(arg);
		const { entries, shims, outputs } = await buildPackageBundle(packageDir);
		console.log(`${relative(root, packageDir)}: ${entries} entries, ${shims} shims, ${outputs} built files`);
	}
}
