import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migratePiStateToLunr } from "../src/migrations.ts";

let root: string;
let piHome: string;
let lunrAgentDir: string;

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lunr-migrate-pi-state-"));
	piHome = join(root, ".pi");
	lunrAgentDir = join(root, ".lunr", "agent");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("migratePiStateToLunr", () => {
	test("copies pi-era files into the lunr dirs when dest is missing", () => {
		write(join(piHome, "agent", "mcp.json"), `{"mcpServers":{}}`);
		write(join(piHome, "agent", "mcp-cache.json"), `{}`);
		write(join(piHome, "agent", "mcp-npx-cache.json"), `{}`);
		write(join(piHome, "agent", "mcp-onboarding.json"), `{}`);
		write(join(piHome, "agent", "pi-goal-state.json"), `{}`);
		write(join(piHome, "web-search.json"), `{"keys":{}}`);
		write(join(piHome, "simple-memory", "memory.md"), "remember this\n");
		write(join(piHome, "simple-memory", "config.json"), `{"charCap":5000}`);

		const copied = migratePiStateToLunr(piHome, lunrAgentDir);

		expect(readFileSync(join(lunrAgentDir, "mcp.json"), "utf-8")).toBe(`{"mcpServers":{}}`);
		expect(readFileSync(join(lunrAgentDir, "mcp-cache.json"), "utf-8")).toBe(`{}`);
		expect(readFileSync(join(lunrAgentDir, "mcp-npx-cache.json"), "utf-8")).toBe(`{}`);
		expect(readFileSync(join(lunrAgentDir, "mcp-onboarding.json"), "utf-8")).toBe(`{}`);
		expect(readFileSync(join(lunrAgentDir, "pi-goal-state.json"), "utf-8")).toBe(`{}`);
		expect(readFileSync(join(lunrAgentDir, "web-search.json"), "utf-8")).toBe(`{"keys":{}}`);
		const lunrMemoryDir = join(root, ".lunr", "simple-memory");
		expect(readFileSync(join(lunrMemoryDir, "memory.md"), "utf-8")).toBe("remember this\n");
		expect(readFileSync(join(lunrMemoryDir, "config.json"), "utf-8")).toBe(`{"charCap":5000}`);
		expect(copied.length).toBe(8);
	});

	test("copies mcp-oauth recursively", () => {
		write(join(piHome, "agent", "mcp-oauth", "tokens", "server.json"), `{"access":"x"}`);

		migratePiStateToLunr(piHome, lunrAgentDir);

		expect(readFileSync(join(lunrAgentDir, "mcp-oauth", "tokens", "server.json"), "utf-8")).toBe(`{"access":"x"}`);
	});

	test("existing destination wins and is never overwritten", () => {
		write(join(piHome, "agent", "mcp.json"), `{"mcpServers":{"old":{}}}`);
		write(join(lunrAgentDir, "mcp.json"), `{"mcpServers":{"new":{}}}`);

		const copied = migratePiStateToLunr(piHome, lunrAgentDir);

		expect(readFileSync(join(lunrAgentDir, "mcp.json"), "utf-8")).toBe(`{"mcpServers":{"new":{}}}`);
		expect(copied).toEqual([]);
	});

	test("source files under ~/.pi are left untouched", () => {
		const src = join(piHome, "agent", "mcp.json");
		write(src, `{"mcpServers":{}}`);

		migratePiStateToLunr(piHome, lunrAgentDir);

		expect(existsSync(src)).toBe(true);
		expect(readFileSync(src, "utf-8")).toBe(`{"mcpServers":{}}`);
	});

	test("missing source is a quiet no-op", () => {
		const copied = migratePiStateToLunr(piHome, lunrAgentDir);

		expect(copied).toEqual([]);
		expect(existsSync(lunrAgentDir)).toBe(false);
	});

	test("is idempotent across repeated runs", () => {
		write(join(piHome, "agent", "pi-goal-state.json"), `{"a":1}`);

		migratePiStateToLunr(piHome, lunrAgentDir);
		write(join(lunrAgentDir, "pi-goal-state.json"), `{"a":2}`);
		const copied = migratePiStateToLunr(piHome, lunrAgentDir);

		expect(copied).toEqual([]);
		expect(readFileSync(join(lunrAgentDir, "pi-goal-state.json"), "utf-8")).toBe(`{"a":2}`);
	});
});
