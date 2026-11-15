import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeRewriteTool } from "../src/builtin-extensions/pi-lsp-extension/src/tools/code-rewrite.ts";
import type { TreeSitterManager } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts";
import { applyRewrites } from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/rewrite-engine.ts";
import {
	type SearchMatch,
	searchFiles,
} from "../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/search-engine.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

vi.mock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/pattern-compiler.ts", () => ({
	compilePattern: vi.fn(async () => ({ metavars: [], languageId: "typescript" })),
}));
vi.mock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/search-engine.ts", () => ({
	searchFiles: vi.fn(),
}));

const extensionContext = {} as ExtensionContext;

let profile: string;
let previousAgentDir: string | undefined;
beforeEach(async () => {
	profile = await mkdtemp(join(tmpdir(), "lunr-rewrite-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(profile, "agent");
	await mkdir(process.env.PI_CODING_AGENT_DIR);
	vi.clearAllMocks();
});
afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(profile, { recursive: true, force: true });
});

function match(file: string, source: string, text = "old"): SearchMatch {
	const startIndex = source.indexOf(text);
	return {
		file,
		matchedText: text,
		sourceHash: createHash("sha256").update(source).digest("hex"),
		startIndex,
		endIndex: startIndex + text.length,
		captures: {},
		line: 1,
		column: startIndex + 1,
	};
}

describe("structural rewrite mutation", () => {
	it("applies current matches and preserves statement semicolons", async () => {
		const file = join(profile, "source.ts");
		await writeFile(file, "old; old;");
		const first = match(file, "old; old;", "old;");
		const second = { ...first, startIndex: 5, endIndex: 9, column: 6 };
		const result = await applyRewrites([first, second], "new", profile);
		expect(await readFile(file, "utf8")).toBe("new; new;");
		expect(result.filesModified).toBe(1);
		expect(result.failures).toEqual([]);
	});

	it("rejects a changed full snapshot even when the matched substring is unchanged", async () => {
		const file = join(profile, "source.ts");
		await writeFile(file, "old; changed elsewhere");
		const result = await applyRewrites([match(file, "old; original elsewhere")], "new", profile);
		expect(await readFile(file, "utf8")).toBe("old; changed elsewhere");
		expect(result.filesModified).toBe(0);
		expect(result.failures[0].reason).toContain("Source changed");
	});

	it("waits for an existing file mutation, then validates the resulting snapshot", async () => {
		const file = join(profile, "source.ts");
		await writeFile(file, "old");
		let release!: () => void;
		let entered!: () => void;
		const acquired = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const writer = withFileMutationQueue(file, async () => {
			entered();
			await hold;
			await writeFile(file, "intervening edit");
		});
		await acquired;
		let settled = false;
		const rewrite = applyRewrites([match(file, "old")], "new", profile).then((result) => {
			settled = true;
			return result;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(settled).toBe(false);
			expect(await readFile(file, "utf8")).toBe("old");
		} finally {
			release();
		}
		await writer;
		const result = await rewrite;
		expect(result.filesModified).toBe(0);
		expect(result.failures[0].reason).toContain("Source changed");
		expect(await readFile(file, "utf8")).toBe("intervening edit");
	});

	it("preflights all protected targets before changing any matched file", async () => {
		const allowed = join(profile, "source.ts");
		const protectedFile = join(profile, "agent", "settings.json");
		await writeFile(allowed, "old");
		await writeFile(protectedFile, "old");
		const result = await applyRewrites([match(allowed, "old"), match(protectedFile, "old")], "new", profile);
		expect(result.filesModified).toBe(0);
		expect(result.failures[0].file).toBe(protectedFile);
		expect(await readFile(allowed, "utf8")).toBe("old");
		expect(await readFile(protectedFile, "utf8")).toBe("old");
	});

	it("reports a failed write as possibly partial and stops before later files", async () => {
		const file = join(profile, "source.ts");
		const skipped = join(profile, "skipped.ts");
		await writeFile(file, "old");
		await writeFile(skipped, "old");
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(writeFile).mockImplementationOnce(async () => {
			await actual.writeFile(file, "part");
			throw new Error("injected write failure");
		});
		vi.mocked(searchFiles).mockResolvedValue([match(file, "old"), match(skipped, "old")]);
		const tool = createCodeRewriteTool(profile, {} as TreeSitterManager);
		const result = await tool.execute(
			"apply",
			{
				pattern: "old",
				replacement: "new",
				language: "typescript",
				dry_run: false,
			},
			undefined,
			undefined,
			extensionContext,
		);
		expect(result.details).toMatchObject({
			filesModified: 0,
			skippedFiles: [skipped],
			failures: [{ file, writeAttempted: true }],
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("may have partially changed") });
		expect(await readFile(file, "utf8")).toBe("part");
		expect(await readFile(skipped, "utf8")).toBe("old");
	});

	it("reports earlier changes and unattempted files after a later stale match", async () => {
		const files = ["first.ts", "stale.ts", "last.ts"].map((name) => join(profile, name));
		for (const file of files) await writeFile(file, "old");
		await writeFile(files[1], "changed");
		const result = await applyRewrites(
			files.map((file) => match(file, "old")),
			"new",
			profile,
		);
		expect(result.modifiedFiles).toEqual([files[0]]);
		expect(result.failures.map((failure) => failure.file)).toEqual([files[1]]);
		expect(result.skippedFiles).toEqual([files[2]]);
		expect(await Promise.all(files.map((file) => readFile(file, "utf8")))).toEqual(["new", "changed", "old"]);
	});
});

describe("code_rewrite tool guidance and destination checks", () => {
	it.each(["directory", "default"])(
		"rejects protected matches with %s scope and keeps preview usable",
		async (scope) => {
			const file = join(profile, "agent", "settings.json");
			await writeFile(file, "old");
			vi.mocked(searchFiles).mockResolvedValue([match(file, "old")]);
			const changed = vi.fn();
			const tool = createCodeRewriteTool(profile, {} as TreeSitterManager, { onFileModified: changed });
			const params = {
				pattern: "old",
				replacement: "new",
				language: "typescript",
				path: scope === "directory" ? profile : undefined,
			};
			const preview = await tool.execute("preview", params, undefined, undefined, extensionContext);
			expect(preview.content[0]).toMatchObject({ text: expect.stringContaining("Dry run") });
			const result = await tool.execute(
				"apply",
				{ ...params, dry_run: false },
				undefined,
				undefined,
				extensionContext,
			);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Rewrite stopped") });
			expect(result.details).toMatchObject({
				filesModified: 0,
				failures: [{ file, reason: expect.stringContaining("user-managed") }],
			});
			expect(changed).not.toHaveBeenCalled();
			expect(await readFile(file, "utf8")).toBe("old");
		},
	);

	it("documents stale/protected rejection and partial results in the registered contract", () => {
		const tool = createCodeRewriteTool(profile, {} as TreeSitterManager);
		expect(tool.description).toContain("protected targets and stale source snapshots");
		expect(tool.description).toContain("earlier changes in place");
		expect({ name: tool.name, description: tool.description, parameters: tool.parameters }).toMatchSnapshot();
	});
});
