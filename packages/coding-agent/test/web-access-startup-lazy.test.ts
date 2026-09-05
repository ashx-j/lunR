import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const webAccessDir = join(dirname(fileURLToPath(import.meta.url)), "../src/builtin-extensions/pi-web-access");

const HEAVY_STATIC_IMPORT_TARGETS = [
	"./extract.ts",
	"./github-extract.ts",
	"./gemini-search.ts",
	"./curator-server.ts",
	"./summary-review.ts",
	"./gemini-web.ts",
	"./chrome-cookies.ts",
	"./perplexity.ts",
	"./exa.ts",
	"./brave.ts",
	"./openai-search.ts",
	"./parallel.ts",
	"./tavily.ts",
	"./gemini-api.ts",
	"./pdf-extract.ts",
	"./youtube-extract.ts",
	"./video-extract.ts",
	"./curator-page.ts",
] as const;

function valueImportSpecifiers(source: string): string[] {
	const specs: string[] = [];
	const re = /^\s*import\s+(?!type\b)[^;]*?\s+from\s+["']([^"']+)["']/gm;
	for (const match of source.matchAll(re)) {
		specs.push(match[1]);
	}
	return specs;
}

describe("pi-web-access startup dependency reduction", () => {
	it("keeps index registration free of heavy value imports", () => {
		const source = readFileSync(join(webAccessDir, "index.ts"), "utf8");
		const specs = valueImportSpecifiers(source);
		for (const heavy of HEAVY_STATIC_IMPORT_TARGETS) {
			expect(specs, `index must not value-import ${heavy}`).not.toContain(heavy);
		}
		expect(specs).toContain("./lazy.ts");
		expect(specs).toContain("./session-cleanup.ts");
		expect(specs).toContain("./storage.ts");
		expect(specs).toContain("./render-search-chrome.ts");
	});

	it("keeps gemini-search free of eager provider value imports", () => {
		const source = readFileSync(join(webAccessDir, "gemini-search.ts"), "utf8");
		const specs = valueImportSpecifiers(source);
		for (const heavy of [
			"./brave.ts",
			"./exa.ts",
			"./openai-search.ts",
			"./parallel.ts",
			"./tavily.ts",
			"./perplexity.ts",
			"./gemini-web.ts",
			"./gemini-api.ts",
			"./chrome-cookies.ts",
		]) {
			expect(specs, `gemini-search must not value-import ${heavy}`).not.toContain(heavy);
		}
		expect(specs).toContain("./lazy.ts");
	});

	it("keeps extract free of specialized extractor value imports", () => {
		const source = readFileSync(join(webAccessDir, "extract.ts"), "utf8");
		const specs = valueImportSpecifiers(source);
		for (const heavy of [
			"./pdf-extract.ts",
			"./github-extract.ts",
			"./youtube-extract.ts",
			"./video-extract.ts",
			"./gemini-url-context.ts",
			"./parallel.ts",
			"./gemini-web.ts",
			"./chrome-cookies.ts",
		]) {
			expect(specs, `extract must not value-import ${heavy}`).not.toContain(heavy);
		}
		// HTML path still needs readability stack
		expect(specs).toContain("linkedom");
		expect(specs).toContain("./lazy.ts");
	});
});

describe("pi-web-access lazy first-use runtime", () => {
	const loadExtract = vi.fn();
	const loadGeminiSearch = vi.fn();
	const loadCuratorServer = vi.fn();
	const loadSummaryReview = vi.fn();
	const loadGeminiWeb = vi.fn();
	const loadGeminiApi = vi.fn();
	const loadOpenAISearch = vi.fn();
	const loadBrave = vi.fn();
	const loadParallel = vi.fn();
	const loadTavily = vi.fn();
	const loadPerplexity = vi.fn();
	const loadExa = vi.fn();

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.doMock("../src/builtin-extensions/pi-web-access/lazy.ts", () => ({
			loadExtract,
			loadGeminiSearch,
			loadCuratorServer,
			loadSummaryReview,
			loadGeminiWeb,
			loadGeminiApi,
			loadOpenAISearch,
			loadBrave,
			loadParallel,
			loadTavily,
			loadPerplexity,
			loadExa,
			loadGithubExtract: vi.fn(),
			loadPdfExtract: vi.fn(),
			loadYoutubeExtract: vi.fn(),
			loadVideoExtract: vi.fn(),
			loadGeminiUrlContext: vi.fn(),
			resetLazyCachesForTests: vi.fn(),
		}));
	});

	afterEach(() => {
		vi.doUnmock("../src/builtin-extensions/pi-web-access/lazy.ts");
		vi.resetModules();
	});

	function createPi() {
		const tools = new Map<string, any>();
		const commands = new Map<string, any>();
		const handlers = new Map<string, Array<(...args: any[]) => any>>();
		const messages: any[] = [];
		const entries: any[] = [];
		const pi = {
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			registerShortcut() {},
			on(event: string, handler: (...args: any[]) => any) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
			sendMessage(msg: unknown) {
				messages.push(msg);
			},
		};
		return { pi, tools, commands, handlers, messages, entries };
	}

	async function loadFactory() {
		const mod = await import("../src/builtin-extensions/pi-web-access/index.ts");
		return mod.default as (pi: any) => void;
	}

	it("registers tools and commands without loading heavy implementation modules", async () => {
		const factory = await loadFactory();
		const { pi, tools, commands, handlers } = createPi();
		factory(pi);

		expect(tools.has("web_search")).toBe(true);
		expect(tools.has("fetch_content")).toBe(true);
		expect(tools.has("get_search_content")).toBe(true);
		expect(commands.has("websearch")).toBe(true);
		expect(commands.has("curator")).toBe(true);
		expect(commands.has("google-account")).toBe(true);
		expect(commands.has("search")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);

		expect(loadExtract).not.toHaveBeenCalled();
		expect(loadGeminiSearch).not.toHaveBeenCalled();
		expect(loadCuratorServer).not.toHaveBeenCalled();
		expect(loadSummaryReview).not.toHaveBeenCalled();
		expect(loadGeminiWeb).not.toHaveBeenCalled();
		expect(loadBrave).not.toHaveBeenCalled();
		expect(loadOpenAISearch).not.toHaveBeenCalled();
	});

	it("loads extract on first fetch_content use and honors abort after the import boundary", async () => {
		const fetchAllContent = vi.fn(async () => {
			throw new Error("fetchAllContent should not run after abort");
		});
		loadExtract.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 20));
			return { fetchAllContent };
		});

		const factory = await loadFactory();
		const { pi, tools } = createPi();
		factory(pi);

		const tool = tools.get("fetch_content");
		expect(tool).toBeTruthy();

		const controller = new AbortController();
		const executePromise = tool.execute(
			"call-1",
			{ url: "https://example.com/page" },
			controller.signal,
			undefined,
		);
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		const result = await executePromise;

		expect(loadExtract).toHaveBeenCalledTimes(1);
		expect(fetchAllContent).not.toHaveBeenCalled();
		expect(result.details?.error).toBe("Aborted");
	});

	it("loads gemini-search on first web_search use", async () => {
		const search = vi.fn(async () => ({
			answer: "ok",
			results: [{ title: "t", url: "https://example.com", snippet: "" }],
			inlineContent: undefined,
			provider: "brave",
		}));
		loadGeminiSearch.mockResolvedValue({ search });

		const factory = await loadFactory();
		const { pi, tools, entries } = createPi();
		factory(pi);

		const tool = tools.get("web_search");
		const result = await tool.execute(
			"call-2",
			{ query: "test query", workflow: "none", provider: "brave" },
			undefined,
			undefined,
			{ hasUI: false },
		);

		expect(loadGeminiSearch).toHaveBeenCalledTimes(1);
		expect(search).toHaveBeenCalled();
		expect(loadExtract).not.toHaveBeenCalled();
		expect(loadCuratorServer).not.toHaveBeenCalled();
		expect(result.details?.error).toBeUndefined();
		expect(entries.some((e) => e.type === "web-search-results")).toBe(true);
	});

	it("drops stale background fetch completions after session change during extract import", async () => {
		let resolveExtract!: (value: { fetchAllContent: typeof vi.fn }) => void;
		const fetchAllContent = vi.fn(async () => [
			{ url: "https://example.com/a", title: "A", content: "body", error: null },
		]);
		loadExtract.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveExtract = resolve;
				}),
		);
		loadGeminiSearch.mockResolvedValue({
			search: vi.fn(async () => ({
				answer: "ans",
				results: [{ title: "t", url: "https://example.com/a", snippet: "" }],
				inlineContent: undefined,
				provider: "brave",
			})),
		});

		const factory = await loadFactory();
		const { pi, tools, handlers, messages, entries } = createPi();
		factory(pi);

		const tool = tools.get("web_search");
		const executePromise = tool.execute(
			"call-3",
			{ query: "stale fetch", workflow: "none", provider: "brave", includeContent: true },
			undefined,
			undefined,
			{ hasUI: false },
		);

		// Wait until background fetch has requested extract load
		for (let i = 0; i < 50 && loadExtract.mock.calls.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(loadExtract).toHaveBeenCalled();

		const sessionHandlers = handlers.get("session_start") ?? [];
		for (const handler of sessionHandlers) {
			await handler({}, { sessionManager: { getBranch: () => [] } });
		}

		resolveExtract({ fetchAllContent });
		await executePromise;
		await new Promise((r) => setTimeout(r, 30));

		// Session change aborts/clears pending fetches before extract resolves, so work must not resume.
		expect(fetchAllContent).not.toHaveBeenCalled();
		expect(messages.some((m: any) => m?.customType === "web-search-content-ready")).toBe(false);
		expect(entries.filter((e) => e.type === "web-search-results" && e.data?.type === "fetch")).toHaveLength(0);
	});
});
