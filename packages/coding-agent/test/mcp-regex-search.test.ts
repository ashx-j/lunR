import { describe, expect, it } from "vitest";
import { executeSearch } from "../src/builtin-extensions/pi-mcp-adapter/proxy-modes.ts";
import type { McpExtensionState } from "../src/builtin-extensions/pi-mcp-adapter/state.ts";
import type { ToolMetadata } from "../src/builtin-extensions/pi-mcp-adapter/types.ts";

function state(tools: ToolMetadata[]): McpExtensionState {
	return { toolMetadata: new Map([["srv", tools]]) } as unknown as McpExtensionState;
}
const tool = (name: string, description: string): ToolMetadata => ({ name, originalName: name, description });

describe("MCP regex search", () => {
	it("runs a pattern that can backtrack when the text does not make it", async () => {
		const result = await executeSearch(state([tool("srv_a", "aaa")]), "(a+)+$", true);
		expect(result.details).toMatchObject({ count: 1 });
	});

	it("stops a catastrophic match without blocking the event loop", async () => {
		await executeSearch(state([tool("srv_warm", "warm")]), "warm", true);
		let last = performance.now();
		let longestGap = 0;
		const ticker = setInterval(() => {
			const now = performance.now();
			longestGap = Math.max(longestGap, now - last);
			last = now;
		}, 5);
		const result = await executeSearch(state([tool("srv_slow", `${"a".repeat(40)}!`)]), "(a+)+$", true);
		// Let the ticker run once more, so a search that blocked the loop shows up as a gap.
		await new Promise((resolve) => setTimeout(resolve, 20));
		clearInterval(ticker);
		expect(result.details).toMatchObject({ error: "unsafe_pattern" });
		// The match runs off the main thread, so the loop keeps ticking through the 100 ms limit.
		expect(longestGap).toBeLessThan(80);
	});

	it("starts a new worker for an ordinary search after a catastrophic one stopped the last", async () => {
		const slow = state([tool("srv_slow", `${"a".repeat(40)}!`)]);
		const tools = state([tool("srv_read", "Read a file"), tool("srv_write", "Write a file")]);
		for (let round = 0; round < 3; round++) {
			expect((await executeSearch(slow, "(a+)+$", true)).details).toMatchObject({ error: "unsafe_pattern" });
			// The time limit covers matching only, not the new worker's start-up.
			expect((await executeSearch(tools, "^srv_read$", true)).details).toMatchObject({ count: 1 });
		}
	});

	it("gives a search running beside a catastrophic one its own result", async () => {
		const slow = state([tool("srv_slow", `${"a".repeat(40)}!`)]);
		const tools = state([tool("srv_read", "Read a file"), tool("srv_write", "Write a file")]);
		const [stopped, found] = await Promise.all([
			executeSearch(slow, "(a+)+$", true),
			executeSearch(tools, "^srv_", true),
		]);
		expect(stopped.details).toMatchObject({ error: "unsafe_pattern" });
		expect(found.details).toMatchObject({ count: 2 });
	});

	it("matches tool names and descriptions and reports invalid patterns", async () => {
		const tools = state([
			tool("srv_read", "Read a file"),
			tool("srv_write", "Write a file"),
			tool("srv_list", "List items"),
		]);
		expect((await executeSearch(tools, "^srv_(read|write)$", true)).details).toMatchObject({ count: 2 });
		expect((await executeSearch(tools, "items$", true)).details).toMatchObject({ count: 1 });
		expect((await executeSearch(tools, "(", true)).details).toMatchObject({ error: "invalid_pattern" });
	});
});
