import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeSearchTool } from "../src/builtin-extensions/pi-lsp-extension/src/tools/code-search.ts";
import { TreeSitterManager } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts";
import { compilePattern } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/pattern-compiler.ts";

const vendoredDir = join(
	import.meta.dirname,
	"../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/vendored-grammars",
);
const managers: TreeSitterManager[] = [];
let root = "";
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) manager.shutdown();
	if (root) await rm(root, { recursive: true, force: true });
	root = "";
});
function manager(): TreeSitterManager {
	const created = new TreeSitterManager();
	managers.push(created);
	return created;
}

it("loads every mapped grammar in a source run, taking the vendored build where there is one", async () => {
	const manifest: Record<string, { sha256: string }> = JSON.parse(
		await readFile(join(vendoredDir, "manifest.json"), "utf8"),
	);
	const treeSitter = manager();
	let vendored = 0;
	for (const language of treeSitter.getSupportedLanguages()) {
		const path = treeSitter.grammarPath(language) ?? "";
		expect(await treeSitter.getLanguage(language), language).not.toBeNull();
		const entry = manifest[path.split(/[\\/]/).at(-1) ?? ""];
		if (entry) {
			expect(
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex"),
				language,
			).toBe(entry.sha256);
			vendored += 1;
		} else expect(path, language).toContain("tree-sitter-wasms");
	}
	// typescript, typescriptreact, javascript, javascriptreact, bash, cpp, lua
	expect(vendored).toBe(7);
});

it("compiles a Lua pattern after an earlier Lua parse without looping", async () => {
	const treeSitter = manager();
	expect(await treeSitter.parseWithLanguage("a.lua", "x = 1", "lua")).not.toBeNull();
	// The tree-sitter-wasms Lua build spins on this input after earlier parses, until the parse bound.
	await expect(compilePattern("foo", "lua", treeSitter)).rejects.toThrow("Failed to parse pattern as lua");
	expect((await treeSitter.parseWithLanguage("b.lua", "y = 2", "lua"))?.rootNode.hasError).toBe(false);
});

it("says which files it could not search when their parse hit the time bound", async () => {
	root = await mkdtemp(join(tmpdir(), "lunr-slow-parse-"));
	await writeFile(join(root, "slow.ts"), "console.log(1);\n");
	await writeFile(join(root, "fast.ts"), "const x = 1;\n");
	const treeSitter = manager();
	const parse = treeSitter.parseWithLanguage.bind(treeSitter);
	vi.spyOn(treeSitter, "parseWithLanguage").mockImplementation((file, content, language) =>
		file.endsWith("slow.ts") ? Promise.resolve(null) : parse(file, content, language),
	);
	vi.spyOn(treeSitter, "parseTimedOut").mockImplementation((file) => file.endsWith("slow.ts"));
	const tool = createCodeSearchTool(root, treeSitter);
	const result = await tool.execute(
		"call",
		{ pattern: "console.log($$$A)", language: "typescript" },
		undefined,
		undefined,
		undefined as never,
	);
	const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	expect(text).toContain("No matches found.");
	expect(text).toContain("Skipped 1 file that took over 5 s to parse, so they were not searched: slow.ts.");
});

it("reports Swift as having no grammar instead of loading one V8 cannot compile", async () => {
	await expect(compilePattern("foo($A)", "swift", manager())).rejects.toThrow("No tree-sitter grammar for swift");
});
