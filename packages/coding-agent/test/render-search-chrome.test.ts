import { describe, expect, test } from "vitest";
import {
	formatFetchChrome,
	formatSearchChrome,
} from "../src/builtin-extensions/pi-web-access/render-search-chrome.ts";

describe("web_search chrome", () => {
	const queries = [
		"xAI Grok OAuth refresh token expires revoked login",
		"xAI SuperGrok weekly usage pool",
		"lunR catalog refresh models",
		"VS Code integrated terminal Alt+V paste",
	];
	const details = {
		queryCount: 4,
		successfulQueries: 4,
		totalResults: 20,
		summary: { text: "Summary of four searches about OAuth and catalog refresh." },
		curatedQueries: [
			{ query: queries[0], sources: [{ title: "Source A", url: "https://example.com/a" }] },
		],
	};

	test("collapsed 4-query search is a single title line that includes the count", () => {
		const chrome = formatSearchChrome({ queries, details, expanded: false });
		expect(chrome.call).toContain("search 4 queries");
		expect(chrome.call).toContain("4/4 queries");
		expect(chrome.call).toContain("20 sources");
		expect(chrome.result).toEqual([]);
		expect(chrome.call).not.toContain(queries[0]);
	});

	test("expanded 4-query search lists queries only", () => {
		const chrome = formatSearchChrome({ queries, details, expanded: true });
		const result = chrome.result.join("\n");
		for (const query of queries) {
			expect(result).toContain(query);
		}
		expect(result).not.toContain("Summary");
		expect(result).not.toContain("Source A");
		expect(result).not.toContain("ctrl+o to expand");
	});
});

describe("fetch_content chrome", () => {
	const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];

	test("collapsed multi-URL fetch is a single title line that includes the count", () => {
		const chrome = formatFetchChrome({
			urls,
			details: { urlCount: 3, successful: 3 },
			expanded: false,
		});
		expect(chrome.call).toContain("fetch 3 URLs");
		expect(chrome.call).toContain("3/3 URLs");
		expect(chrome.result).toEqual([]);
		expect(chrome.call).not.toContain("https://example.com/a");
	});

	test("expanded multi-URL fetch lists URLs only", () => {
		const chrome = formatFetchChrome({
			urls,
			details: { urlCount: 3, successful: 3 },
			expanded: true,
		});
		const result = chrome.result.join("\n");
		for (const url of urls) {
			expect(result).toContain(url);
		}
		expect(result).not.toContain("chars");
		expect(result).not.toContain("prompt");
	});
});
