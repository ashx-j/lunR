#!/usr/bin/env node
// Copies the grammars parser-manager.ts maps into one folder: the vendored build when
// vendored-grammars/manifest.json lists one (see its README), otherwise the tree-sitter-wasms
// file. The coding-agent dist and the standalone binary both use this, so the published package
// does not depend on tree-sitter-wasms (about 50 MB, 36 languages) and both ship the same files.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const treeSitter = join(root, "packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/tree-sitter");
const vendored = join(treeSitter, "vendored-grammars");
const destination = resolve(
	process.argv[2] ?? join(root, "packages/coding-agent/dist/builtin-extensions/pi-lsp-extension/src/tree-sitter/grammars"),
);
const source = readFileSync(join(treeSitter, "parser-manager.ts"), "utf8");
const grammars = [...new Set(source.match(/tree-sitter-[a-z_]+\.wasm/g) ?? [])];
if (grammars.length === 0) throw new Error("No grammar file names found in parser-manager.ts");
const manifest = JSON.parse(readFileSync(join(vendored, "manifest.json"), "utf8"));
const out = join(dirname(createRequire(join(root, "packages/coding-agent/package.json")).resolve("tree-sitter-wasms/package.json")), "out");
mkdirSync(destination, { recursive: true });
// A grammar dropped from the map must not stay behind in a folder an earlier build filled.
for (const file of readdirSync(destination)) {
	if (/^tree-sitter-[a-z_]+\.wasm$/.test(file) && !grammars.includes(file)) rmSync(join(destination, file));
}
for (const grammar of grammars) copyFileSync(join(grammar in manifest ? vendored : out, grammar), join(destination, grammar));
console.log(`Copied ${grammars.length} tree-sitter grammars (${grammars.filter((name) => name in manifest).length} vendored).`);
