import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectUsageHistory, resetUsageHistoryCache } from "../src/core/usage-history.ts";

const NOW = Date.now();

function assistantEntry(
	id: string,
	timestamp: string,
	provider: string,
	model: string,
	usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
	responseModel?: string,
): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `answer from ${id}` }],
			api: "openai-completions",
			provider,
			model,
			...(responseModel ? { responseModel } : {}),
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead ?? 0,
				cacheWrite: usage.cacheWrite ?? 0,
				totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(timestamp),
		},
	});
}

function userEntry(id: string, timestamp: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
	});
}

function sessionFile(id: string, entries: string[]): string {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: new Date(NOW).toISOString(),
		cwd: "/tmp/project",
	});
	return `${[header, ...entries].join("\n")}\n`;
}

describe("collectUsageHistory", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lunr-usage-history-"));
		resetUsageHistoryCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUsageHistoryCache();
	});

	it("aggregates real per-model totals across flat and subdirectory layouts", () => {
		writeFileSync(
			join(dir, "flat.jsonl"),
			sessionFile("s1", [
				userEntry("u1", "2026-08-10T10:00:00.000Z", "hello there"),
				assistantEntry("a1", "2026-08-10T10:01:00.000Z", "openai", "gpt-5", {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
				}),
			]),
		);
		const subDir = join(dir, "--tmp-project--");
		mkdirSync(subDir);
		writeFileSync(
			join(subDir, "nested.jsonl"),
			sessionFile("s2", [
				assistantEntry("a2", "2026-08-11T10:01:00.000Z", "openai", "gpt-5", { input: 200, output: 100 }),
				assistantEntry("a3", "2026-08-11T10:02:00.000Z", "anthropic", "claude", { input: 7, output: 3 }),
			]),
		);

		const history = collectUsageHistory({ sinceMs: NOW - 30 * 24 * 60 * 60 * 1000, sessionsDir: dir });

		expect(history.filesScanned).toBe(2);
		expect(history.sessionsWithUsage).toBe(2);
		expect(history.perModel).toEqual([
			{ model: "openai/gpt-5", input: 300, output: 150, cacheRead: 10, cacheWrite: 5, total: 465 },
			{ model: "anthropic/claude", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
		]);
		// Categories carry the messages (no system prompt/tools in session files).
		expect(history.includesSystemPrompt).toBe(false);
		expect(history.categories.user).toBeGreaterThan(0);
		expect(history.categories.assistantText).toBeGreaterThan(0);
		expect(history.categories.total).toBe(history.categories.user + history.categories.assistantText);
	});

	it("buckets totals per day from entry timestamps", () => {
		writeFileSync(
			join(dir, "days.jsonl"),
			sessionFile("s1", [
				assistantEntry("a1", "2026-08-01T23:00:00.000Z", "openai", "gpt-5", { input: 10, output: 5 }),
				assistantEntry("a2", "2026-08-02T01:00:00.000Z", "openai", "gpt-5", { input: 20, output: 10 }),
				assistantEntry("a3", "2026-08-02T02:00:00.000Z", "openai", "gpt-5", {
					input: 1,
					output: 1,
					cacheRead: 4,
				}),
			]),
		);

		const history = collectUsageHistory({ sinceMs: NOW - 30 * 24 * 60 * 60 * 1000, sessionsDir: dir });

		expect(history.perDay).toEqual([
			{ day: "2026-08-01", total: 15 },
			{ day: "2026-08-02", total: 36 },
		]);
	});

	it("excludes files older than sinceMs (mtime filter)", () => {
		const oldFile = join(dir, "old.jsonl");
		writeFileSync(
			oldFile,
			sessionFile("s1", [
				assistantEntry("a1", "2026-07-01T10:00:00.000Z", "openai", "gpt-5", { input: 9, output: 9 }),
			]),
		);
		const old = (NOW - 40 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(oldFile, old, old);

		writeFileSync(
			join(dir, "new.jsonl"),
			sessionFile("s2", [
				assistantEntry("a2", "2026-08-10T10:00:00.000Z", "openai", "gpt-5", { input: 1, output: 1 }),
			]),
		);

		const history = collectUsageHistory({ sinceMs: NOW - 30 * 24 * 60 * 60 * 1000, sessionsDir: dir });

		expect(history.filesScanned).toBe(1);
		expect(history.perModel).toEqual([
			{ model: "openai/gpt-5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		]);
	});

	it("skips corrupt lines and files without a valid header", () => {
		const good = sessionFile("s1", [
			assistantEntry("a1", "2026-08-10T10:00:00.000Z", "openai", "gpt-5", { input: 4, output: 2 }),
		]);
		// Inject an unparseable line in the middle of an otherwise valid file.
		writeFileSync(join(dir, "mixed.jsonl"), good.replace("\n", "\n{not json\n"));
		writeFileSync(join(dir, "garbage.jsonl"), "this is not a session file at all\n{also not}\n");

		const history = collectUsageHistory({ sinceMs: NOW - 30 * 24 * 60 * 60 * 1000, sessionsDir: dir });

		expect(history.filesScanned).toBe(2);
		expect(history.sessionsWithUsage).toBe(1);
		expect(history.perModel).toEqual([
			{ model: "openai/gpt-5", input: 4, output: 2, cacheRead: 0, cacheWrite: 0, total: 6 },
		]);
	});

	it("returns an empty aggregate for an empty or missing directory", () => {
		const history = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(history.perModel).toEqual([]);
		expect(history.perDay).toEqual([]);
		expect(history.categories.total).toBe(0);
		expect(history.filesScanned).toBe(0);
		expect(history.sessionsWithUsage).toBe(0);

		const missing = collectUsageHistory({ sinceMs: 0, sessionsDir: join(dir, "does-not-exist") });
		expect(missing.filesScanned).toBe(0);
		expect(missing.perModel).toEqual([]);
	});

	it("re-parses nothing on a second call (cache hit)", () => {
		writeFileSync(
			join(dir, "a.jsonl"),
			sessionFile("s1", [
				assistantEntry("a1", "2026-08-10T10:00:00.000Z", "openai", "gpt-5", { input: 1, output: 1 }),
			]),
		);

		const first = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(first.filesParsed).toBe(1);

		const second = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(second.filesParsed).toBe(0);
		expect(second.perModel).toEqual(first.perModel);
	});

	it("re-parses a file when its mtime/size changes (cache invalidation)", () => {
		const file = join(dir, "a.jsonl");
		writeFileSync(
			file,
			sessionFile("s1", [
				assistantEntry("a1", "2026-08-10T10:00:00.000Z", "openai", "gpt-5", { input: 1, output: 1 }),
			]),
		);

		const first = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(first.filesParsed).toBe(1);
		expect(first.perModel[0].total).toBe(2);

		appendFileSync(
			file,
			`${assistantEntry("a2", "2026-08-10T11:00:00.000Z", "openai", "gpt-5", { input: 10, output: 10 })}\n`,
		);

		const second = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(second.filesParsed).toBe(1);
		expect(second.perModel[0].total).toBe(22);
	});

	it("drops cache entries for deleted files", () => {
		const file = join(dir, "a.jsonl");
		writeFileSync(
			file,
			sessionFile("s1", [
				assistantEntry("a1", "2026-08-10T10:00:00.000Z", "openai", "gpt-5", { input: 1, output: 1 }),
			]),
		);
		collectUsageHistory({ sinceMs: 0, sessionsDir: dir });

		rmSync(file);
		const history = collectUsageHistory({ sinceMs: 0, sessionsDir: dir });
		expect(history.filesScanned).toBe(0);
		expect(history.perModel).toEqual([]);
	});
});
