import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { stageStandaloneAssets } from "../../../scripts/distribution-assets.mjs";
import { streamClaudeCode } from "../src/api/anthropic-claude-code-bridge.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

const mocks = vi.hoisted(() => ({ directory: "", spawn: vi.fn(), loggedIn: false }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ access: vi.fn().mockResolvedValue(undefined), constants: { X_OK: 1 } }));
vi.mock("../src/utils/claude-code-assets.ts", async (importOriginal) => {
	const { getClaudeCodeWorkerPath } = await importOriginal<typeof import("../src/utils/claude-code-assets.ts")>();
	return {
		getClaudeCodeWorkerPath: (worker: Parameters<typeof getClaudeCodeWorkerPath>[0]) =>
			getClaudeCodeWorkerPath(worker, {
				moduleUrl: "file:///$bunfs/root/worker-path-test.js",
				execPath: join(mocks.directory, "lunr"),
			}),
	};
});

afterEach(() => {
	rmSync(mocks.directory, { recursive: true, force: true });
	mocks.spawn.mockReset();
	mocks.loggedIn = false;
	vi.unstubAllEnvs();
});

it("passes relocated physical workers to generation, setup probes, and login handoff", async () => {
	mocks.directory = mkdtempSync(join(tmpdir(), "lunr-claude-paths-"));
	stageStandaloneAssets(mocks.directory);
	vi.stubEnv("PATH", join(mocks.directory, "fake-bin"));
	mocks.spawn.mockImplementation((_command: string, args: string[]) => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			pid: 0,
			exitCode: null as number | null,
			kill: vi.fn(),
			stdin: new Writable({
				write(chunk, _encoding, callback) {
					const request = JSON.parse(String(chunk)) as { type: string; requestId: string };
					queueMicrotask(() => {
						if (request.type !== "start") {
							const result =
								request.type === "version"
									? "2.1.263"
									: request.type === "discover"
										? [{ id: "claude-sonnet-5", upstream_requests: 0 }]
										: { logged_in: mocks.loggedIn, plan: "Claude Pro", accountFingerprint: "fake-account" };
							child.stdout.write(
								`${JSON.stringify({ v: 1, requestId: request.requestId, type: "result", result })}\n`,
							);
						}
						child.exitCode = 0;
						child.emit("close", 0);
					});
					callback();
				},
			}),
		});
		if (args[0] === "--version") {
			queueMicrotask(() => {
				child.stdout.write("Python 3.11.1");
				child.exitCode = 0;
				child.emit("close", 0);
			});
		}
		return child;
	});
	const handoff = vi.fn().mockImplementation(async () => {
		mocks.loggedIn = true;
	});
	const connection = await anthropicOAuth.login({ prompt: async () => "login", notify: vi.fn(), handoff });
	expect(connection).toMatchObject({ type: "external_claude_code", accountFingerprint: "fake-account" });
	const setupWorker = join(mocks.directory, "vendor/hermes-claude-subscription-directsdk/lunr_setup_bridge.py");
	for (const [, args] of mocks.spawn.mock.calls.filter(([, args]) => args[0] !== "--version")) {
		expect(args).toEqual(["-s", "-B", "-u", setupWorker]);
	}
	expect(handoff).toHaveBeenCalledWith(
		expect.any(String),
		["-s", "-B", "-u", setupWorker, "auth-login", expect.any(String)],
		expect.any(Object),
	);
	if (connection.type !== "external_claude_code") throw new Error("Unexpected credential type");
	const model = anthropicProvider()
		.getModels()
		.find((item) => item.id === "claude-sonnet-5");
	if (!model) throw new Error("Missing test model");
	await streamClaudeCode(model, { messages: [] }, { externalClaudeCode: connection }).result();
	expect(mocks.spawn).toHaveBeenLastCalledWith(
		connection.python,
		["-s", "-B", "-u", join(mocks.directory, "vendor/hermes-claude-subscription-directsdk/lunr_bridge.py")],
		expect.any(Object),
	);
});
