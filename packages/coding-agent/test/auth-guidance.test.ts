import { describe, expect, it } from "vitest";
import { formatClaudeSubscriptionLogoutNote } from "../src/core/auth-guidance.ts";

describe("formatClaudeSubscriptionLogoutNote", () => {
	it("says Claude Code's sign-in and the downloaded copy stay, and where the copy is", () => {
		const note = formatClaudeSubscriptionLogoutNote({
			type: "external_claude_code",
			version: 2,
			manager: "claude-code",
			command: "/home/me/.lunr/agent/claude-code/2.1.263/claude",
		});
		expect(note).toContain("sign-in is unchanged");
		expect(note).toContain("/home/me/.lunr/agent/claude-code/2.1.263");
		expect(note).toContain('"/home/me/.lunr/agent/claude-code/2.1.263/claude" auth logout');
	});

	it("does not call an older record's binary a lunR download", () => {
		const note = formatClaudeSubscriptionLogoutNote({
			type: "external_claude_code",
			version: 1,
			manager: "claude-code",
			command: "/usr/local/bin/claude",
		});
		expect(note).toBe("Claude Code's own sign-in is unchanged.");
	});
});
