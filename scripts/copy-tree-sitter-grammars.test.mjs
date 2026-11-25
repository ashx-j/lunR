import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../packages/coding-agent/package.json", import.meta.url));
const treeSitter = "packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/tree-sitter";
const dist = "packages/coding-agent/dist/builtin-extensions/pi-lsp-extension/src/tree-sitter/grammars";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Each mapped grammar file with the SHA-256 the build must ship: the vendored one when listed. */
function expectedGrammars() {
	const source = readFileSync(join(treeSitter, "parser-manager.ts"), "utf8");
	const mapped = [...new Set(source.match(/"tree-sitter-[a-z_]+\.wasm"/g).map((name) => name.slice(1, -1)))].sort();
	const manifest = JSON.parse(readFileSync(join(treeSitter, "vendored-grammars/manifest.json"), "utf8"));
	const out = join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
	return new Map(mapped.map((file) => [file, manifest[file]?.sha256 ?? sha256(join(out, file))]));
}

test("the build copies exactly the mapped grammars, vendored builds first, and each one loads", async () => {
	const expected = expectedGrammars();
	assert.equal([...expected.keys()].filter((file) => file.includes("lua") || file.includes("typescript")).length, 2);
	const destination = mkdtempSync(join(tmpdir(), "lunr-grammars-"));
	try {
		execFileSync(process.execPath, ["scripts/copy-tree-sitter-grammars.mjs", destination]);
		assert.deepEqual(readdirSync(destination).sort(), [...expected.keys()]);
		for (const [file, hash] of expected) assert.equal(sha256(join(destination, file)), hash, file);
		const Parser = require("web-tree-sitter");
		await Parser.init();
		for (const file of expected.keys()) assert.ok(await Parser.Language.load(join(destination, file)), file);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
});

test("a built dist ships the same grammar files the copy script selects", { skip: !existsSync(dist) && "no build" }, () => {
	const expected = expectedGrammars();
	assert.deepEqual(readdirSync(dist).filter((file) => file.endsWith(".wasm")).sort(), [...expected.keys()]);
	for (const [file, hash] of expected) assert.equal(sha256(join(dist, file)), hash, file);
});
