import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	it("keeps lazy first-use loaders pointed at their heavy modules", () => {
		const source = readFileSync(join(webAccessDir, "lazy.ts"), "utf8");
		expect(source).toContain('loadExtract = () => import("./extract.ts")');
		expect(source).toContain('loadGeminiSearch = () => import("./gemini-search.ts")');
		expect(source).toContain('loadCuratorServer = () => import("./curator-server.ts")');
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
		}));
	});

	afterEach(() => {
		vi.doUnmock("../src/builtin-extensions/pi-web-access/lazy.ts");
		vi.resetModules();
	});

	type TestTool = { name: string; execute: (...args: unknown[]) => Promise<{ details?: Record<string, unknown> }> };
	type Handler = (...args: unknown[]) => unknown;

	function createPi() {
		const tools = new Map<string, TestTool>();
		const commands = new Map<string, unknown>();
		const handlers = new Map<string, Handler[]>();
		const messages: Array<{ customType?: string }> = [];
		const entries: Array<{ type: string; data: { type?: string } }> = [];
		const pi = {
			registerTool(tool: TestTool) {
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: unknown) {
				commands.set(name, command);
			},
			registerShortcut() {},
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			appendEntry(type: string, data: { type?: string }) {
				entries.push({ type, data });
			},
			sendMessage(msg: { customType?: string }) {
				messages.push(msg);
			},
		};
		return { pi, tools, commands, handlers, messages, entries };
	}

	async function loadFactory() {
		const mod = await import("../src/builtin-extensions/pi-web-access/index.ts");
		return mod.default as unknown as (pi: ReturnType<typeof createPi>["pi"]) => void;
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
		const executePromise = tool.execute("call-1", { url: "https://example.com/page" }, controller.signal, undefined);
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

	it("does not cancel another factory's background content fetch on session start", async () => {
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const active = new Promise<void>((resolve) => {
			started = resolve;
		});
		loadGeminiSearch.mockResolvedValue({
			search: async () => ({
				answer: "ok",
				results: [{ title: "t", url: "https://example.com", snippet: "" }],
				provider: "brave",
			}),
		});
		loadExtract.mockResolvedValue({
			fetchAllContent: async () => {
				started();
				await gate;
				return [{ url: "https://example.com", title: "ok", content: "body", error: null }];
			},
		});

		const factory = await loadFactory();
		const first = createPi();
		const second = createPi();
		factory(first.pi);
		factory(second.pi);
		const sessionContext = { sessionManager: { getBranch: () => [] } };
		for (const handler of first.handlers.get("session_start") ?? []) await handler({}, sessionContext);

		await first.tools
			.get("web_search")
			.execute(
				"first",
				{ query: "test", workflow: "none", provider: "brave", includeContent: true },
				undefined,
				undefined,
				{ hasUI: false },
			);
		await active;
		for (const handler of second.handlers.get("session_start") ?? []) await handler({}, sessionContext);
		release();

		await vi.waitFor(() =>
			expect(first.messages.some((message) => message.customType === "web-search-content-ready")).toBe(true),
		);
	});

	it("does not abort another factory's in-flight fetch on session start", async () => {
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const active = new Promise<void>((resolve) => {
			started = resolve;
		});
		loadExtract.mockResolvedValue({
			fetchAllContent: async () => {
				started();
				await gate;
				return [{ url: "https://example.com", title: "ok", content: "body", error: null }];
			},
		});

		const factory = await loadFactory();
		const first = createPi();
		const second = createPi();
		factory(first.pi);
		factory(second.pi);

		const pending = first.tools
			.get("fetch_content")
			.execute("first", { url: "https://example.com" }, undefined, undefined, { hasUI: false });
		await active;
		for (const handler of second.handlers.get("session_start") ?? []) {
			await handler({}, { sessionManager: { getBranch: () => [] } });
		}
		release();

		const result = await pending;
		expect(result.details?.error).toBeUndefined();
	});

	it.each(["fetch_content", "web_search"])(
		"does not publish stale %s results after session replacement",
		async (name) => {
			let release!: () => void;
			let started!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const active = new Promise<void>((resolve) => {
				started = resolve;
			});
			loadExtract.mockResolvedValue({
				fetchAllContent: async () => {
					started();
					await gate;
					return [{ url: "https://example.com", title: "old", content: "old result", error: null }];
				},
			});
			loadGeminiSearch.mockResolvedValue({
				search: async () => {
					started();
					await gate;
					throw new DOMException("Aborted", "AbortError");
				},
			});
			const factory = await loadFactory();
			const { pi, tools, handlers, entries } = createPi();
			factory(pi);
			const pending = tools
				.get(name)
				.execute("stale", { url: "https://example.com", query: "test", workflow: "none" }, undefined, undefined, {
					hasUI: false,
				});
			const rejected = expect(pending).rejects.toThrow(/abort|cancel/i);
			await active;
			for (const handler of handlers.get("session_start") ?? [])
				await handler({}, { sessionManager: { getBranch: () => [] } });
			release();
			await rejected;
			expect(entries).toEqual([]);
		},
	);

	it("does not open a stale curator command after its implementation loads", async () => {
		loadOpenAISearch.mockResolvedValue({ isOpenAISearchAvailable: async () => false });
		loadBrave.mockResolvedValue({ isBraveAvailable: () => false });
		loadParallel.mockResolvedValue({ isParallelAvailable: () => false });
		loadTavily.mockResolvedValue({ isTavilyAvailable: () => false });
		loadPerplexity.mockResolvedValue({ isPerplexityAvailable: () => false });
		loadExa.mockResolvedValue({ isExaAvailable: () => false });
		loadGeminiApi.mockResolvedValue({ isGeminiApiAvailable: () => false });
		loadGeminiWeb.mockResolvedValue({ isGeminiWebAvailable: async () => null });
		loadSummaryReview.mockResolvedValue({});
		const startCuratorServer = vi.fn();
		let release!: (module: { startCuratorServer: typeof startCuratorServer }) => void;
		loadCuratorServer.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const factory = await loadFactory();
		const { pi, commands, handlers } = createPi();
		factory(pi);
		const command = commands.get("websearch") as { handler: (args: string, ctx: unknown) => Promise<void> };
		const notify = vi.fn();
		const pending = command.handler("", {
			cwd: webAccessDir,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => false,
			ui: { notify },
		});
		await vi.waitFor(() => expect(loadCuratorServer).toHaveBeenCalled());
		for (const handler of handlers.get("session_start") ?? [])
			await handler({}, { sessionManager: { getBranch: () => [] } });
		notify.mockClear();
		release({ startCuratorServer });
		await pending;
		expect(startCuratorServer).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
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
		expect(messages.some((m) => m?.customType === "web-search-content-ready")).toBe(false);
		expect(entries.filter((e) => e.type === "web-search-results" && e.data?.type === "fetch")).toHaveLength(0);
	});
});
