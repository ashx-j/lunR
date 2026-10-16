import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { AuthEvent, AuthPrompt } from "../src/auth/types.ts";
import {
	CLAUDE_CODE_VERSION,
	claudeCodePlatform,
	installClaudeCode,
	managedClaudeCodePath,
} from "../src/utils/claude-code-release.ts";

vi.mock("../src/utils/claude-code-release.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/claude-code-release.ts")>()),
	installClaudeCode: vi.fn(),
}));

const platform = claudeCodePlatform();
// The fake binaries are shell scripts.
const supported = process.platform !== "win32" && platform !== undefined;

const WORKING = `#!/bin/sh\necho "${CLAUDE_CODE_VERSION} (Claude Code)"\n`;
const BROKEN = "#!/bin/sh\nexit 1\n";

function writeBinary(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, 0o755);
}

describe.skipIf(!supported).sequential("Claude Code install check", () => {
	let agentDir: string;
	let command: string;
	let prompts: AuthPrompt[];
	let events: AuthEvent[];

	// Answers the download prompt and records it. Login stops at the sign-in step because the fake
	// binary reports no account and the interaction has no terminal handoff.
	const interaction = (answer: string) => ({
		prompt: async (prompt: AuthPrompt) => {
			prompts.push(prompt);
			return answer;
		},
		notify: (event: AuthEvent) => {
			events.push(event);
		},
	});

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "lunr-claude-install-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		command = managedClaudeCodePath(platform!);
		prompts = [];
		events = [];
		vi.mocked(installClaudeCode).mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("reuses a working binary without prompting or downloading", async () => {
		writeBinary(command, WORKING);
		await expect(anthropicOAuth.login(interaction("cancel"))).rejects.toThrow("auth login");
		expect(prompts).toEqual([]);
		expect(installClaudeCode).not.toHaveBeenCalled();
		expect(existsSync(command)).toBe(true);
	});

	it("replaces a binary that no longer runs after the user agrees to download", async () => {
		writeBinary(command, BROKEN);
		vi.mocked(installClaudeCode).mockImplementation(async (_platform, target) => writeBinary(target, WORKING));
		await expect(anthropicOAuth.login(interaction("download"))).rejects.toThrow("auth login");
		expect(events.some((event) => event.type === "info" && event.message.includes("does not run"))).toBe(true);
		expect(prompts).toHaveLength(1);
		expect(installClaudeCode).toHaveBeenCalledOnce();
	});

	it("removes a broken binary and asks again when the user declines the download", async () => {
		writeBinary(command, BROKEN);
		await expect(anthropicOAuth.login(interaction("cancel"))).rejects.toThrow("cancelled");
		expect(prompts).toHaveLength(1);
		expect(existsSync(command)).toBe(false);
	});

	it("deletes a fresh download that fails its version check", async () => {
		vi.mocked(installClaudeCode).mockImplementation(async (_platform, target) => writeBinary(target, BROKEN));
		await expect(anthropicOAuth.login(interaction("download"))).rejects.toThrow("does not run");
		expect(existsSync(command)).toBe(false);
	});
});
