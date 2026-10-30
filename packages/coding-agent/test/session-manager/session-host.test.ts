import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHostError, SessionManager, setSessionHost } from "../../src/core/session-manager.ts";

describe("sessions owned by a host app", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lunr-session-host-"));
	});
	afterEach(() => {
		setSessionHost(undefined);
		rmSync(root, { recursive: true, force: true });
	});

	function hostSession(): string {
		setSessionHost("surface");
		const session = SessionManager.create(root, join(root, "surface"));
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
		const file = session.getSessionFile()!;
		session.dispose();
		return file;
	}

	it("lets the owning host reopen it and refuses to continue or fork it anywhere else", () => {
		const file = hostSession();
		expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0]!).host).toBe("surface");
		SessionManager.open(file).dispose();

		setSessionHost(undefined);
		expect(() => SessionManager.open(file)).toThrow(SessionHostError);
		expect(() => SessionManager.forkFrom(file, root, join(root, "cli"))).toThrow(SessionHostError);
		expect(() => SessionManager.forkBranch(file, SessionManager.openReadOnly(file).getLeafId()!)).toThrow(
			SessionHostError,
		);
		// Browsing and export stay possible.
		expect(SessionManager.openReadOnly(file).getHeader()?.host).toBe("surface");
	});
});
