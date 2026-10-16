import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { AuthInteraction, AuthPrompt } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { CLAUDE_CODE_VERSION } from "../src/utils/claude-code-release.ts";

/** What the fake Claude Code binary answers; each test sets what it needs. */
const fake = vi.hoisted(() => ({
	managedPath: "",
	statuses: [] as unknown[],
	discovery: "",
	admitted: false,
	calls: [] as string[][],
	installs: 0,
}));

vi.mock("../src/api/claude-code-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/api/claude-code-process.ts")>()),
	stopProcessTree: async () => {},
	spawnClaudeCode: (_command: string, args: readonly string[]) => {
		fake.calls.push([...args]);
		const stdout = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			pid: 1,
			stdout,
			stdin: {
				end: () => {
					const output = args.includes("--version")
						? `${CLAUDE_CODE_VERSION} (Claude Code)`
						: args.includes("status")
							? JSON.stringify(fake.statuses.shift())
							: args.includes("-p")
								? fake.discovery
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
	ClaudeCodeLoopback: {
		open: async () => ({ baseUrl: "http://127.0.0.1:1", admitted: fake.admitted, close: () => {} }),
	},
}));
vi.mock("../src/utils/claude-code-release.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/claude-code-release.ts")>()),
	claudeCodePlatform: () => "linux-x64",
	managedClaudeCodePath: () => fake.managedPath,
	installClaudeCode: async () => {
		fake.installs++;
	},
}));

const subscriber = { loggedIn: true, subscriptionType: "max", email: "Person@Example.com" };
const signedOut = { loggedIn: false };
const picker = (...values: string[]) =>
	`${JSON.stringify({ type: "control_response", response: { response: { models: values.map((value) => ({ value })) } } })}\n`;

/** Answers prompts from a fixed script and records every notice. */
function interaction(answers: string[], handoff?: AuthInteraction["handoff"]) {
	const prompts: AuthPrompt[] = [];
	const notices: string[] = [];
	const value: AuthInteraction = {
		prompt: async (prompt) => {
			prompts.push(prompt);
			const answer = answers.shift();
			if (!answer) throw new Error("unexpected prompt");
			return answer;
		},
		notify: (event) => notices.push(event.message),
		handoff,
	};
	return { value, prompts, notices };
}

function runtime() {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(anthropicProvider());
	return { credentials, login: (value: AuthInteraction) => models.login("anthropic", "oauth", value) };
}

describe("Anthropic subscription login", () => {
	beforeEach(() => {
		// process.execPath exists on disk, so setup treats it as an already-downloaded Claude Code.
		fake.managedPath = process.execPath;
		fake.statuses = [subscriber];
		fake.discovery = picker("sonnet", "haiku");
		fake.admitted = false;
		fake.calls = [];
		fake.installs = 0;
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	it("saves a version 2 record with routes and no secrets after a normal sign-in", async () => {
		const { credentials, login } = runtime();
		const credential = await login(interaction([]).value);
		expect(credential).toEqual({
			type: "external_claude_code",
			version: 2,
			manager: "claude-code",
			command: process.execPath,
			accountFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			routes: ["claude-sonnet-5[1m]", "claude-haiku-4-5-20251001"],
		});
		expect(JSON.stringify(credential)).not.toContain("Person@Example.com");
		expect(await credentials.read("anthropic")).toEqual(credential);
	});

	it("asks before downloading and stops when the user declines", async () => {
		fake.managedPath = "/nonexistent/claude-code/claude";
		const { credentials, login } = runtime();
		const { value, prompts } = interaction(["cancel"]);
		await expect(login(value)).rejects.toThrow("Anthropic subscription setup cancelled");
		expect(prompts).toHaveLength(1);
		expect(fake.installs).toBe(0);
		expect(fake.calls).toEqual([]);
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("downloads and verifies the version after the user agrees", async () => {
		fake.managedPath = "/nonexistent/claude-code/claude";
		const { login } = runtime();
		const credential = await login(interaction(["download"]).value);
		expect(fake.installs).toBe(1);
		expect(fake.calls[0]).toEqual(["--version"]);
		expect(credential).toMatchObject({ command: "/nonexistent/claude-code/claude" });
	});

	it("hands the terminal to `auth login` when Claude Code is not signed in, then saves", async () => {
		fake.statuses = [signedOut, subscriber];
		const handoff = vi.fn(async () => {});
		const { credentials, login } = runtime();
		const credential = await login(interaction(["login"], handoff).value);
		expect(handoff).toHaveBeenCalledWith(process.execPath, ["auth", "login"], expect.any(Object));
		expect(await credentials.read("anthropic")).toEqual(credential);
	});

	it("tells headless callers to sign in by hand when there is no terminal handoff", async () => {
		fake.statuses = [signedOut];
		const { credentials, login } = runtime();
		await expect(login(interaction([]).value)).rejects.toThrow("auth login");
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("saves nothing when the user declines the sign-in handoff", async () => {
		fake.statuses = [signedOut];
		const handoff = vi.fn(async () => {});
		const { credentials, login } = runtime();
		await expect(login(interaction(["cancel"], handoff).value)).rejects.toThrow("setup cancelled");
		expect(handoff).not.toHaveBeenCalled();
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("rejects a signed-in account without a subscription and saves nothing", async () => {
		fake.statuses = [signedOut, { loggedIn: true, subscriptionType: "free", email: "a@example.com" }];
		const { credentials, login } = runtime();
		await expect(login(interaction(["login"], async () => {}).value)).rejects.toThrow(
			"not signed in to a Claude subscription",
		);
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("saves nothing when discovery lists no usable models", async () => {
		fake.discovery = picker("some-future-model");
		const { credentials, login } = runtime();
		await expect(login(interaction([]).value)).rejects.toThrow("did not list any models");
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("saves nothing when discovery contacts Anthropic", async () => {
		fake.admitted = true;
		const { credentials, login } = runtime();
		await expect(login(interaction([]).value)).rejects.toThrow("contacted Anthropic");
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("skips malformed discovery lines instead of failing with a raw SyntaxError", async () => {
		fake.discovery = `{not json\n${picker("sonnet")}`;
		const { login } = runtime();
		const credential = await login(interaction([]).value);
		expect(credential).toMatchObject({ routes: ["claude-sonnet-5[1m]"] });
	});
});
