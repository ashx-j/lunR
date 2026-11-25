#!/usr/bin/env node
// Copies only the grammars parser-manager.ts maps into the coding-agent dist, so the
// published package does not depend on tree-sitter-wasms (about 50 MB, 36 languages).
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const treeSitter = join(root, "packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/tree-sitter");
const destination = resolve(
	process.argv[2] ?? join(root, "packages/coding-agent/dist/builtin-extensions/pi-lsp-extension/src/tree-sitter/grammars"),
);
const source = readFileSync(join(treeSitter, "parser-manager.ts"), "utf8");
const grammars = [...new Set(source.match(/tree-sitter-[a-z_]+\.wasm/g) ?? [])];
if (grammars.length === 0) throw new Error("No grammar file names found in parser-manager.ts");
const out = join(dirname(createRequire(join(root, "packages/coding-agent/package.json")).resolve("tree-sitter-wasms/package.json")), "out");
mkdirSync(destination, { recursive: true });
for (const grammar of grammars) copyFileSync(join(out, grammar), join(destination, grammar));
console.log(`Copied ${grammars.length} tree-sitter grammars.`);
