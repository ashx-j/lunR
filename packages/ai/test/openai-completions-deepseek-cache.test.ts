import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	usage: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-ds",
								choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
								usage: mockState.usage,
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function deepseekModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

describe("openai-completions DeepSeek cache usage", () => {
	beforeEach(() => {
		mockState.usage = undefined;
	});

	it("maps prompt_cache_miss_tokens to input and prompt_cache_hit_tokens to cacheRead", async () => {
		mockState.usage = {
			prompt_tokens: 120,
			completion_tokens: 10,
			prompt_cache_hit_tokens: 80,
			prompt_cache_miss_tokens: 40,
		};

		const message = await complete(
			deepseekModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.usage.cacheRead).toBe(80);
		expect(message.usage.input).toBe(40);
		expect(message.usage.output).toBe(10);
	});
});
