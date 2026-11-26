import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TreeSitterManager } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts";

let root = "";
afterEach(async () => {
	vi.unstubAllEnvs();
	if (root) await rm(root, { recursive: true, force: true });
	root = "";
});

it("loads grammars from grammars/ beside a standalone executable", async () => {
	root = await mkdtemp(join(tmpdir(), "lunr-grammars-"));
	const out = join(dirname(createRequire(import.meta.url).resolve("tree-sitter-wasms/package.json")), "out");
	await mkdir(join(root, "grammars"));
	await copyFile(join(out, "tree-sitter-python.wasm"), join(root, "grammars", "tree-sitter-python.wasm"));
	// getPackageDir() is the executable's directory in a Bun binary; PI_PACKAGE_DIR stands in for it.
	vi.stubEnv("PI_PACKAGE_DIR", root);
	const treeSitter = new TreeSitterManager();
	try {
		expect(await treeSitter.getLanguage("python")).not.toBeNull();
		// Only that folder is used, so a grammar missing from it is unavailable rather than an error.
		expect(await treeSitter.getLanguage("typescript")).toBeNull();
	} finally {
		treeSitter.shutdown();
	}
});
