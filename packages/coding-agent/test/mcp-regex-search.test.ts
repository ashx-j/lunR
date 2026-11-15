import { describe, expect, it } from "vitest";
import { executeSearch } from "../src/builtin-extensions/pi-mcp-adapter/proxy-modes.ts";
import type { McpExtensionState } from "../src/builtin-extensions/pi-mcp-adapter/state.ts";
import type { ToolMetadata } from "../src/builtin-extensions/pi-mcp-adapter/types.ts";

function state(tools: ToolMetadata[]): McpExtensionState {
	return { toolMetadata: new Map([["srv", tools]]) } as unknown as McpExtensionState;
}
const tool = (name: string, description: string): ToolMetadata => ({ name, originalName: name, description });

describe("MCP regex search", () => {
	it("stops a catastrophic pattern against a long description within the time limit", () => {
		const started = performance.now();
		const result = executeSearch(state([tool("srv_slow", `${"a".repeat(40)}!`)]), "(a+)+$", true);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(result.details).toMatchObject({ error: "unsafe_pattern" });
	});

	it("matches tool names and descriptions and reports invalid patterns", () => {
		const tools = state([
			tool("srv_read", "Read a file"),
			tool("srv_write", "Write a file"),
			tool("srv_list", "List items"),
		]);
		expect(executeSearch(tools, "^srv_(read|write)$", true).details).toMatchObject({ count: 2 });
		expect(executeSearch(tools, "items$", true).details).toMatchObject({ count: 1 });
		expect(executeSearch(tools, "(", true).details).toMatchObject({ error: "invalid_pattern" });
	});
});
