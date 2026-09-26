import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

const mock = vi.hoisted(() => ({ response: null as Record<string, unknown> | null, spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

const connection: ExternalClaudeCodeCredential = {
	type: "external_claude_code",
	version: 1,
	manager: "claude-code",
	command: "fake-claude",
	python: "fake-python",
	accountFingerprint: "test-account",
};

function completion(text: string, tool = false): Record<string, unknown> {
	const calls = tool
		? [{ id: "tool_1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }]
		: [];
	const projection = {
		content: text.trim(),
		tool_calls: calls.map((call) => ({ id: call.id, name: call.function.name, input: { path: "x" } })),
	};
	return {
		id: "msg_test",
		choices: [
			{
				finish_reason: tool ? "tool_calls" : "stop",
				message: {
					content: text,
					reasoning_content: "",
					tool_calls: calls,
					reasoning_details: [
						{
							type: "claude-subscription-directsdk-experimental.native_assistant",
							version: 1,
							messages: [{ role: "assistant", content: [{ type: "text", text }] }],
							projection,
						},
					],
				},
			},
		],
		usage: {
			prompt_tokens: 13,
			completion_tokens: 5,
			total_tokens: 18,
			cache_creation_input_tokens: 2,
			prompt_tokens_details: { cached_tokens: 3 },
			native_admission: { upstream_requests: 1 },
		},
	};
}

function fakeWorker(text = "hello", splitUtf8 = false, nativePid?: number) {
	const worker = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		stdin: new Writable({
			write(chunk, _encoding, callback) {
				const request = JSON.parse(String(chunk)) as { requestId: string };
				const send = (type: string, extra: Record<string, unknown> = {}) =>
					worker.stdout.write(`${JSON.stringify({ v: 1, requestId: request.requestId, type, ...extra })}\n`);
				queueMicrotask(() => {
					send("ready");
					if (nativePid) send("native_started", { pid: nativePid });
					send("start");
					if (splitUtf8) {
						const delta = Buffer.from(
							`${JSON.stringify({ v: 1, requestId: request.requestId, type: "text_delta", text })}\n`,
						);
						const boundary = delta.indexOf(0xc3) + 1;
						worker.stdout.write(delta.subarray(0, boundary));
						worker.stdout.write(delta.subarray(boundary));
					} else send("text_delta", { text });
					if (mock.response) send("complete", { response: mock.response });
					worker.exitCode = mock.response ? 0 : 1;
					worker.emit("close", worker.exitCode);
				});
				callback();
			},
		}),
		kill: vi.fn(),
	});
	return worker;
}

describe("Claude Code stream boundary", () => {
	afterEach(() => {
		mock.spawn.mockReset();
		mock.response = null;
	});

	it("publishes native tool calls only after the validated completion", async () => {
		mock.response = completion("hello", true);
		mock.spawn.mockImplementation(() => fakeWorker());
		const model = anthropicProvider()
			.getModels()
			.find((item) => item.id === "claude-sonnet-5")!;
		const stream = anthropicProvider().streamSimple(
			model,
			{
				messages: [{ role: "user", content: "go", timestamp: Date.now() }],
				tools: [{ name: "read", description: "read", parameters: { type: "object" } as never }],
			},
			{ externalClaudeCode: connection },
		);
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(events).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content.at(-1)).toMatchObject({ type: "toolCall", name: "read" });
		expect(result.claudeCodeCarrier?.messages).toHaveLength(1);
		expect(result.usage).toMatchObject({ input: 8, output: 5, cacheRead: 3, cacheWrite: 2 });
	});

	it("preserves UTF-8 characters split across worker chunks", async () => {
		mock.response = completion("héllo");
		mock.spawn.mockImplementation(() => fakeWorker("héllo", true));
		const model = anthropicProvider().getModels()[0]!;
		const stream = anthropicProvider().streamSimple(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ externalClaudeCode: connection },
		);
		for await (const _event of stream) {
		}
		const result = await stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "héllo" }]);
	});

	it("cleans up a native PID after its worker exits abnormally", async () => {
		const nativePid = 4242423;
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		mock.spawn.mockImplementation((command: string) => {
			if (command === "taskkill") {
				const killer = Object.assign(new EventEmitter(), { kill: vi.fn() });
				queueMicrotask(() => killer.emit("close", 0));
				return killer;
			}
			return fakeWorker("hello", false, nativePid);
		});
		try {
			const model = anthropicProvider().getModels()[0]!;
			const result = await anthropicProvider()
				.streamSimple(
					model,
					{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
					{
						externalClaudeCode: connection,
					},
				)
				.result();
			expect(result.stopReason).toBe("error");
			if (process.platform === "win32") {
				await vi.waitFor(() =>
					expect(mock.spawn).toHaveBeenCalledWith(
						"taskkill",
						["/F", "/T", "/PID", String(nativePid)],
						expect.anything(),
					),
				);
			} else await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(-nativePid, "SIGKILL"));
		} finally {
			kill.mockRestore();
		}
	});

	it("discards partial text and never exposes tools on a truncated worker stream", async () => {
		mock.spawn.mockImplementation(() => fakeWorker());
		const model = anthropicProvider().getModels()[0]!;
		const stream = anthropicProvider().streamSimple(
			model,
			{ messages: [{ role: "user", content: "go", timestamp: Date.now() }] },
			{ externalClaudeCode: connection },
		);
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		expect(events).not.toContain("toolcall_end");
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
	});
});
