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
	/** Picker rows the `initialize` handshake returns, and `get_context_usage` windows by route. */
	picker: [] as Record<string, unknown>[],
	windows: {} as Record<string, number>,
	/** Puts a garbled line before every control response. */
	garbled: false,
	tripped: false,
	calls: [] as string[][],
	installs: 0,
}));

vi.mock("../src/api/claude-code-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/api/claude-code-process.ts")>()),
	stopProcessTree: async () => {},
	spawnClaudeCode: (_command: string, args: readonly string[]) => {
		fake.calls.push([...args]);
		const stdout = new EventEmitter();
		const emit = (text: string) => queueMicrotask(() => stdout.emit("data", Buffer.from(text)));
		let model = "";
		const child = Object.assign(new EventEmitter(), {
			pid: 1,
			stdout,
			stdin: {
				on: () => {},
				// Discovery talks over the control channel, one request per line.
				write: (line: string) => {
					const { request_id, request } = JSON.parse(line);
					fake.calls.push([request.subtype, request.model ?? ""]);
					if (request.subtype === "set_model") model = request.model;
					const response =
						request.subtype === "initialize"
							? { models: fake.picker }
							: request.subtype === "get_context_usage"
								? { maxTokens: fake.windows[model] }
								: {};
					const reply = { type: "control_response", response: { subtype: "success", request_id, response } };
					emit(`${fake.garbled ? "{not json\n" : ""}${JSON.stringify(reply)}\n`);
				},
				// Other setup commands answer once on end.
				end: () => {
					if (!args.includes("-p"))
						emit(
							args.includes("--version")
								? `${CLAUDE_CODE_VERSION} (Claude Code)`
								: args.includes("status")
									? JSON.stringify(fake.statuses.shift())
									: "",
						);
					queueMicrotask(() => queueMicrotask(() => child.emit("close", 0)));
				},
			},
		});
		return child;
	},
}));
vi.mock("../src/api/claude-code-loopback.ts", () => ({
	ClaudeCodeTripwire: {
		open: async () => ({ baseUrl: "http://127.0.0.1:1", tripped: fake.tripped, close: () => {} }),
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
const row = (value: string, resolvedModel: string, description = "") => ({ value, resolvedModel, description });
const sonnet = row("sonnet", "claude-sonnet-5");
const haiku = row("haiku", "claude-haiku-4-5-20251001");

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
		fake.picker = [sonnet, haiku];
		fake.windows = { "claude-sonnet-5": 200_000, "claude-haiku-4-5-20251001": 200_000 };
		fake.garbled = false;
		fake.tripped = false;
		fake.calls = [];
		fake.installs = 0;
		delete process.env.CLAUDE_CONFIG_DIR;
	});

	it("saves a version 3 record with Claude Code's models and windows and no secrets", async () => {
		const { credentials, login } = runtime();
		const credential = await login(interaction([]).value);
		expect(credential).toEqual({
			type: "external_claude_code",
			version: 3,
			manager: "claude-code",
			command: process.execPath,
			accountFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
			models: [
				{ id: "claude-sonnet-5", route: "claude-sonnet-5", contextWindow: 200_000 },
				{ id: "claude-haiku-4-5-20251001", route: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
			],
		});
		expect(JSON.stringify(credential)).not.toContain("Person@Example.com");
		expect(await credentials.read("anthropic")).toEqual(credential);
	});

	it("keeps each model's largest window on the plan and skips variants billed from usage credits", async () => {
		fake.picker = [
			row("default", "claude-sonnet-5"),
			sonnet,
			row("sonnet[1m]", "claude-sonnet-5[1m]"),
			row("opus", "claude-opus-5"),
			row("opus[1m]", "claude-opus-5[1m]", "Opus 5 with 1M context · Draws from usage credits · $5/$25 per Mtok"),
			haiku,
		];
		fake.windows = {
			"claude-sonnet-5": 200_000,
			"claude-sonnet-5[1m]": 1_000_000,
			"claude-opus-5": 200_000,
			"claude-opus-5[1m]": 1_000_000,
			"claude-haiku-4-5-20251001": 200_000,
		};
		const { login } = runtime();
		const credential = await login(interaction([]).value);
		expect(credential).toMatchObject({
			models: [
				{ id: "claude-sonnet-5", route: "claude-sonnet-5[1m]", contextWindow: 1_000_000 },
				{ id: "claude-opus-5", route: "claude-opus-5", contextWindow: 200_000 },
				{ id: "claude-haiku-4-5-20251001", route: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
			],
		});
		// The credit-billed variant is never even selected.
		expect(fake.calls).not.toContainEqual(["set_model", "claude-opus-5[1m]"]);
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
		fake.picker = [row("opus[1m]", "claude-opus-5[1m]", "Draws from usage credits")];
		const { credentials, login } = runtime();
		await expect(login(interaction([]).value)).rejects.toThrow("did not list any models");
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("saves nothing when discovery tries to contact Anthropic", async () => {
		fake.tripped = true;
		const { credentials, login } = runtime();
		await expect(login(interaction([]).value)).rejects.toThrow("tried to contact Anthropic");
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("skips malformed discovery lines instead of failing with a raw SyntaxError", async () => {
		fake.garbled = true;
		const { login } = runtime();
		const credential = await login(interaction([]).value);
		expect(credential).toMatchObject({ models: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }] });
	});
});
