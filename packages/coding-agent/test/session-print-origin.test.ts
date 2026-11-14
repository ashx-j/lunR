import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function exchange(session: SessionManager): void {
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
}

describe("print session origin", () => {
	let root: string;
	beforeAll(() => {
		initTheme("moon");
	});
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-print-origin-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("records print origin for new sessions only and lists it", async () => {
		const sessionDir = join(root, "sessions");
		const printed = SessionManager.create(root, sessionDir);
		printed.markPrintOrigin();
		exchange(printed);
		const printedFile = printed.getSessionFile();
		printed.dispose();

		const chat = SessionManager.create(root, sessionDir);
		exchange(chat);
		const chatFile = chat.getSessionFile();
		chat.dispose();

		// Continuing a chat session from print mode must not relabel it.
		const continued = SessionManager.open(chatFile!, sessionDir);
		continued.markPrintOrigin();
		exchange(continued);
		continued.dispose();

		const sessions = await SessionManager.list(root, sessionDir);
		expect(sessions.find((s) => s.path === printedFile)?.origin).toBe("print");
		expect(sessions.find((s) => s.path === chatFile)?.origin).toBeUndefined();
	});

	it("tags print sessions in the /resume list", async () => {
		const base = { cwd: "", created: new Date(0), modified: new Date(0), messageCount: 2, allMessagesText: "" };
		const sessions: SessionInfo[] = [
			{ ...base, path: "/tmp/a.jsonl", id: "a", firstMessage: "from print", origin: "print" },
			{ ...base, path: "/tmp/b.jsonl", id: "b", firstMessage: "from chat" },
		];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const lines = selector.render(120);
		expect(lines.find((line) => line.includes("from print"))).toContain("print · 2 msgs");
		expect(lines.find((line) => line.includes("from chat"))).not.toContain("print ·");
	});
});
