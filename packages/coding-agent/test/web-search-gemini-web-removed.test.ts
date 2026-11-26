import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REMOVED = "Gemini Web (search through your signed-in Google browser) was removed from lunR";
const savedEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
let dir: string;

// Every provider is unavailable, so a search reaches the point where Gemini Web used to answer.
function mockNoProviders() {
	vi.doMock("../src/builtin-extensions/pi-web-access/lazy.ts", () => ({
		loadOpenAISearch: async () => ({ isOpenAISearchAvailable: async () => false }),
		loadExa: async () => ({ isExaAvailable: () => false, hasExaApiKey: () => false }),
		loadBrave: async () => ({ isBraveAvailable: () => false }),
		loadParallel: async () => ({ isParallelAvailable: () => false }),
		loadTavily: async () => ({ isTavilyAvailable: () => false }),
		loadPerplexity: async () => ({ isPerplexityAvailable: () => false }),
		loadGeminiApi: async () => ({ getApiKey: () => null, isGatewayConfigured: () => false }),
	}));
}

describe("web_search after Gemini Web removal", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lunr-gemini-web-"));
		// A temporary HOME keeps any browser profile out of reach of the code under test.
		process.env.HOME = dir;
		process.env.PI_CODING_AGENT_DIR = dir;
		vi.resetModules();
		mockNoProviders();
	});

	afterEach(() => {
		vi.doUnmock("../src/builtin-extensions/pi-web-access/lazy.ts");
		process.env.PI_CODING_AGENT_DIR = savedEnv.agentDir;
		process.env.HOME = savedEnv.home;
		rmSync(dir, { recursive: true, force: true });
	});

	it("tells a Gemini Web user once what to set instead and keeps their saved setting", async () => {
		const configPath = join(dir, "web-search.json");
		const saved = '{ "searchProvider": "gemini", "allowBrowserCookies": true, "chromeProfile": "Default" }\n';
		writeFileSync(configPath, saved);
		const { search } = await import("../src/builtin-extensions/pi-web-access/gemini-search.ts");

		const first = await search("q").catch((err: Error) => err.message);
		expect(first.split("\n")[0]).toContain(REMOVED);
		expect(first).toContain("Set GEMINI_API_KEY");
		expect(first).not.toContain("gemini.google.com");

		const second = await search("q").catch((err: Error) => err.message);
		expect(second).not.toContain(REMOVED);
		expect(second).toContain("Set GEMINI_API_KEY");
		expect(readFileSync(configPath, "utf8")).toBe(saved);
	});

	it("auto names no Google sign-in when nothing is configured", async () => {
		const { search } = await import("../src/builtin-extensions/pi-web-access/gemini-search.ts");
		const message = await search("q", { provider: "auto" }).catch((err: Error) => err.message);
		expect(message).toMatch(/^No search provider available/);
		expect(message).not.toContain("gemini.google.com");
	});
});
