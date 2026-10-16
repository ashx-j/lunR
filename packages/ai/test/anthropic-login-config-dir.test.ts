import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInteraction } from "../src/auth/types.ts";
import { CLAUDE_CODE_VERSION } from "../src/utils/claude-code-release.ts";

type SpawnCall = { args: readonly string[]; env: Record<string, string> };
const spawned: SpawnCall[] = [];
let signedIn = true;

// Fake Claude Code: subscriber (signed in unless a test flips `signedIn`) that lists one model. No real process or download.
vi.mock("../src/api/claude-code-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/api/claude-code-process.ts")>()),
	stopProcessTree: async () => {},
	spawnClaudeCode: (_command: string, args: readonly string[], env: Record<string, string>) => {
		// The pinned-version probe runs before setup reads CLAUDE_CONFIG_DIR, so only later calls are recorded.
		const probe = args.includes("--version");
		if (!probe) spawned.push({ args, env });
		const stdout = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			pid: 1,
			stdout,
			stdin: {
				end: () => {
					const output = probe
						? `${CLAUDE_CODE_VERSION} (Claude Code)`
						: args.includes("status")
							? JSON.stringify(
									signedIn
										? { loggedIn: true, subscriptionType: "max", email: "a@example.com" }
										: { loggedIn: false },
								)
							: args.includes("-p")
								? `${JSON.stringify({ type: "control_response", response: { response: { models: [{ value: "sonnet" }] } } })}\n`
								: "";
					queueMicrotask(() => {
						stdout.emit("data", Buffer.from(output));
						child.emit("close", 0);
					});
				},
			},
		});
		return child;
	},
}));
vi.mock("../src/api/claude-code-loopback.ts", () => ({
	ClaudeCodeLoopback: { open: async () => ({ baseUrl: "http://127.0.0.1:1", admitted: false, close: () => {} }) },
}));
// process.execPath exists on disk, so setup treats it as an already-downloaded Claude Code.
vi.mock("../src/utils/claude-code-release.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/claude-code-release.ts")>()),
	claudeCodePlatform: () => "linux-x64",
	managedClaudeCodePath: () => process.execPath,
}));

const { anthropicOAuth } = await import("../src/auth/oauth/anthropic.ts");

const interaction: AuthInteraction = {
	prompt: async () => {
		throw new Error("unexpected prompt");
	},
	notify: () => {},
};

describe("Anthropic subscription login with CLAUDE_CONFIG_DIR", () => {
	const original = process.env.CLAUDE_CONFIG_DIR;
	beforeEach(() => {
		spawned.length = 0;
		signedIn = true;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = original;
	});

	it("runs sign-in status and discovery against the custom directory and saves it", async () => {
		process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
		const credential = await anthropicOAuth.login!(interaction);
		expect(credential).toMatchObject({ type: "external_claude_code", version: 2, configDir: "/custom/claude" });
		expect(spawned.map((call) => call.args[0])).toEqual(["auth", "-p"]);
		for (const call of spawned) expect(call.env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
	});

	it("passes the directory to the auth login handoff", async () => {
		process.env.CLAUDE_CONFIG_DIR = "/custom/claude";
		signedIn = false;
		const handoff = vi.fn(async () => {
			signedIn = true;
		});
		const credential = await anthropicOAuth.login!({ ...interaction, prompt: async () => "login", handoff });
		expect(handoff).toHaveBeenCalledOnce();
		expect(handoff.mock.calls[0]![2].CLAUDE_CONFIG_DIR).toBe("/custom/claude");
		expect(credential).toMatchObject({ configDir: "/custom/claude" });
		// Both status checks and discovery saw the directory too.
		for (const call of spawned) expect(call.env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
	});

	it("leaves the credential and environment unchanged when the variable is unset or empty", async () => {
		for (const value of [undefined, ""]) {
			spawned.length = 0;
			if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = value;
			const credential = await anthropicOAuth.login!(interaction);
			expect(credential).not.toHaveProperty("configDir");
			for (const call of spawned) expect(call.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
		}
	});
});
