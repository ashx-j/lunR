import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("session file modes", () => {
	let root: string;
	let previousUmask: number;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-session-modes-"));
		previousUmask = process.umask(0o002);
	});
	afterEach(() => {
		process.umask(previousUmask);
		rmSync(root, { recursive: true, force: true });
	});

	function persist(sessionDir: string): string {
		const session = SessionManager.create(root, sessionDir);
		session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const file = session.getSessionFile();
		session.dispose();
		if (!file) throw new Error("Expected a persisted session file");
		return file;
	}

	it("creates owner-only transcripts and session directories", () => {
		const sessionDir = join(root, "sessions", "project");
		const file = persist(sessionDir);
		expect(mode(file)).toBe(0o600);
		expect(mode(sessionDir)).toBe(0o700);
		expect(mode(join(root, "sessions"))).toBe(0o700);
	});

	it("leaves an existing session directory's mode alone", () => {
		const sessionDir = join(root, "existing");
		mkdirSync(sessionDir, { mode: 0o755 });
		const file = persist(sessionDir);
		expect(mode(sessionDir)).toBe(0o755);
		expect(mode(file)).toBe(0o600);
	});
});
