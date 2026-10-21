import { describe, expect, it, vi } from "vitest";
import { resolveDirectTools } from "../src/builtin-extensions/pi-mcp-adapter/direct-tools.ts";
import { computeServerHash, type MetadataCache } from "../src/builtin-extensions/pi-mcp-adapter/metadata-cache.ts";
import type { McpConfig } from "../src/builtin-extensions/pi-mcp-adapter/types.ts";
import { readOnlyModeBlock } from "../src/core/permissions.ts";

function resolve(servers: Record<string, string[]>, prefix: "server" | "none") {
	const config: McpConfig = {
		mcpServers: Object.fromEntries(
			Object.keys(servers).map((name) => [
				name,
				{ command: "mcp-server", directTools: true, exposeResources: false },
			]),
		),
	};
	const cache: MetadataCache = {
		version: 1,
		servers: Object.fromEntries(
			Object.entries(servers).map(([name, tools]) => [
				name,
				{
					configHash: computeServerHash(config.mcpServers[name]),
					cachedAt: Date.now(),
					tools: tools.map((tool) => ({ name: tool, inputSchema: { type: "object" } })),
					resources: [],
				},
			]),
		),
	};
	return resolveDirectTools(config, cache, prefix).map((spec) => spec.prefixedName);
}

describe("resolveDirectTools", () => {
	it("skips direct tools whose names the permission gate trusts", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(resolve({ lsp: ["hover", "format"], goal: ["complete"] }, "server")).toEqual(["lsp_format"]);
			expect(resolve({ any: ["todo", "browser", "subagent", "web_fetch", "lookup"] }, "none")).toEqual(["lookup"]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('"lsp_hover"'));
		} finally {
			warn.mockRestore();
		}
	});

	it("gates repo_map from an MCP server instead of trusting it as read-only", () => {
		expect(resolve({ repo: ["map"] }, "server")).toEqual(["repo_map"]);
		expect(readOnlyModeBlock("repo_map", {})?.block).toBe(true);
	});
});
