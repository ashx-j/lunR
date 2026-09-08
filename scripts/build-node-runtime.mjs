import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/coding-agent/dist");
const outdir = join(dist, "node-runtime");
const artifactDir = join(root, ".artifacts/node-runtime");

rmSync(outdir, { recursive: true, force: true });
const result = await build({
	absWorkingDir: root,
	entryPoints: ["cli-runtime", "main", "index", "rpc-entry"].map((name) => join(dist, `${name}.js`)),
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	target: "node22",
	tsconfigRaw: { compilerOptions: {} },
	define: { LUNR_NODE_BUNDLE: "true" },
	metafile: true,
	minifySyntax: true,
	external: [
		"@earendil-works/*",
		"@ashx-j/*",
		"typebox",
		"chalk",
		"jiti",
		"@mariozechner/clipboard",
		"@silvia-odwyer/photon-node",
		"canvas",
		"web-tree-sitter",
		"tree-sitter-wasms",
		"recheck",
		"open",
		"unpdf",
		"discord.js",
	],
	banner: {
		js: 'import { createRequire as __lunrRequire } from "node:module"; const require = __lunrRequire(import.meta.url);',
	},
	plugins: [
		{
			name: "preserve-module-asset-paths",
			setup(builder) {
				builder.onLoad({ filter: /\.js$/ }, (args) => {
					if (!args.path.startsWith(`${dist}/`) && !args.path.startsWith(`${dist}\\`)) return;
					let contents = readFileSync(args.path, "utf8");
					if (contents.includes("import.meta.url")) {
						// Flat output chunks resolve asset and extension aliases against the original dist layout.
						const original = `../${relative(dist, args.path).replaceAll("\\", "/")}`;
						contents = contents.replaceAll(
							"import.meta.url",
							`new URL(${JSON.stringify(original)}, import.meta.url).href`,
						);
					}
					return { contents, loader: "js" };
				});
			},
		},
	],
});
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "metafile.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
