import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../packages/coding-agent/package.json", import.meta.url));

test("the build copies exactly the grammars the parser manager maps, and each one loads", async () => {
	const destination = mkdtempSync(join(tmpdir(), "lunr-grammars-"));
	try {
		execFileSync(process.execPath, ["scripts/copy-tree-sitter-grammars.mjs", destination]);
		const source = readFileSync(
			"packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts",
			"utf8",
		);
		const mapped = [...new Set(source.match(/"tree-sitter-[a-z_]+\.wasm"/g).map((name) => name.slice(1, -1)))].sort();
		assert.deepEqual(readdirSync(destination).sort(), mapped);
		const Parser = require("web-tree-sitter");
		await Parser.init();
		for (const file of mapped) assert.ok(await Parser.Language.load(join(destination, file)), file);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
});
