import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TreeSitterManager } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts";
import { compilePattern } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/pattern-compiler.ts";
import { applyRewrites } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/rewrite-engine.ts";
import { searchFiles } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/search-engine.ts";

it("carries the source snapshot through real structural matching with Unicode before the match", async () => {
	const root = await mkdtemp(join(tmpdir(), "lunr-structural-parser-"));
	const manager = new TreeSitterManager();
	try {
		const file = join(root, "source.ts");
		const source = 'const label = "é🙂";\nconsole.log(label);\n';
		await writeFile(file, source);
		const pattern = await compilePattern("console.log(label)", "typescript", manager);
		const matches = await searchFiles(pattern, root, manager, { path: file });
		expect(matches).toHaveLength(1);
		expect(matches[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
		const result = await applyRewrites(matches, "console.warn(label)", root);
		expect(result.failures).toEqual([]);
		expect(result.filesModified).toBe(1);
		expect(await readFile(file, "utf8")).toBe(source.replace("console.log", "console.warn"));
	} finally {
		manager.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
