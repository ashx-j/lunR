import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { generateImages } from "../src/api/openrouter-images.ts";
import { getModel } from "../src/compat.ts";
import { calculateCost } from "../src/models.ts";
import type { AssistantMessage, ImagesModel, Model } from "../src/types.ts";
import { createAssistantMessageEventStream } from "../src/utils/event-stream.ts";

const state = vi.hoisted(() => ({ usage: {} as Record<string, unknown> }));
vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => ({
					withResponse: async () => ({
						data: {
							id: "img-test",
							usage: state.usage,
							choices: [{ message: { content: "ok", images: [{ image_url: "data:image/png;base64,YQ==" }] } }],
						},
						response: { status: 200, headers: new Headers() },
					}),
				}),
			},
		};
	},
}));
const model: Model<"openai-codex-responses"> = {
	id: "gpt-6.1-sol",
	name: "review",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 272000,
	maxTokens: 8192,
};
const initial = (): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: model.api,
	provider: model.provider,
	model: model.id,
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});
const reported = {
	input_tokens: 1000,
	input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
	output_tokens: 200,
	output_tokens_details: { reasoning_tokens: 150 },
	total_tokens: 1200,
};
afterEach(() => vi.unstubAllGlobals());
describe("provider usage accounting", () => {
	it("normalizes completed Responses without double-counting reasoning", async () => {
		const output = initial();
		await processResponsesStream(
			(async function* () {
				yield { type: "response.completed", response: { status: "completed", output: [], usage: reported } };
			})() as never,
			output,
			createAssistantMessageEventStream(),
			model,
		);
		expect(output.usage).toMatchObject({
			input: 300,
			output: 200,
			cacheRead: 600,
			cacheWrite: 100,
			reasoning: 150,
			totalTokens: 1200,
		});
	});
	it("retains reported usage on a failed Responses event", async () => {
		const output = initial();
		await expect(
			processResponsesStream(
				(async function* () {
					yield {
						type: "response.failed",
						response: {
							status: "failed",
							output: [],
							usage: reported,
							error: { code: "server_error", message: "fixture failure" },
						},
					};
				})() as never,
				output,
				createAssistantMessageEventStream(),
				model,
			),
		).rejects.toThrow("fixture failure");
		expect(output.usage.totalTokens).toBe(1200);
	});
	it("retains reported usage on a failed Codex SSE event", async () => {
		const body = `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", usage: reported, error: { code: "server_error", message: "fixture failure" } } })}\n\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
		);
		const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "review" } })).toString("base64")}.z`;
		const result = await codexStream(
			model,
			{ messages: [] },
			{ apiKey: token, transport: "sse", maxRetries: 0 },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.usage.totalTokens).toBe(1200);
	});
	it("separates OpenRouter image cache reads and writes", async () => {
		state.usage = {
			prompt_tokens: 100,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
		};
		const imageModel: ImagesModel<"openrouter-images"> = {
			id: "google/review",
			name: "review",
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://example.invalid",
			input: ["text"],
			output: ["image"],
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
		};
		const result = await generateImages(
			imageModel,
			{ input: [{ type: "text", text: "review" }] },
			{ apiKey: "fixture" },
		);
		expect(result.usage).toMatchObject({ input: 20, output: 10, cacheRead: 60, cacheWrite: 20, totalTokens: 110 });
	});
	it("applies Gemini long-context pricing above 200k input", () => {
		const usage = initial().usage;
		usage.input = 300000;
		usage.output = 10000;
		usage.totalTokens = 310000;
		const cost = calculateCost(getModel("google", "gemini-3.1-pro-preview"), usage);
		expect(cost.total).toBeCloseTo(1.38);
	});
	it.each([0, 1.75])(
		"uses the reported OpenRouter image charge %s while retaining component estimates",
		async (charge) => {
			state.usage = { prompt_tokens: 300000, completion_tokens: 10000, cost: charge };
			const base = getModel("google", "gemini-3.1-pro-preview");
			const imageModel: ImagesModel<"openrouter-images"> = {
				id: "google/review",
				name: "review",
				api: "openrouter-images",
				provider: "openrouter",
				baseUrl: "https://example.invalid",
				input: ["text"],
				output: ["image"],
				cost: base.cost,
			};
			const result = await generateImages(
				imageModel,
				{ input: [{ type: "text", text: "review" }] },
				{ apiKey: "fixture" },
			);
			expect(result.usage).toMatchObject({ reportedCost: charge, costSource: "reported", cost: { total: charge } });
			expect(result.usage?.cost.input).toBeCloseTo(1.2);
			expect(result.usage?.cost.output).toBeCloseTo(0.18);
			expect(result.usage?.reasoning).toBeUndefined();
		},
	);
	it("keeps unavailable reasoning distinct from reported zero", async () => {
		for (const reasoning of [undefined, 0]) {
			const output = initial();
			await processResponsesStream(
				(async function* () {
					yield {
						type: "response.completed",
						response: {
							status: "completed",
							output: [],
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								total_tokens: 0,
								output_tokens_details: reasoning === undefined ? undefined : { reasoning_tokens: reasoning },
							},
						},
					};
				})() as never,
				output,
				createAssistantMessageEventStream(),
				model,
			);
			expect(output.usage.reasoning).toBe(reasoning);
			expect(output.usage.measurement).toBe("reported");
			expect(output.usage.totalTokens).toBe(0);
		}
	});
});
