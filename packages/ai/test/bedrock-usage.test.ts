import { describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";

const state = vi.hoisted(() => ({ usage: {} as Record<string, unknown> }));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-bedrock-runtime")>()),
	BedrockRuntimeClient: class {
		async send() {
			return {
				$metadata: {},
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { messageStop: { stopReason: "end_turn" } };
					yield { metadata: { usage: state.usage } };
				})(),
			};
		}
	},
}));
const model: Model<"bedrock-converse-stream"> = {
	id: "global.anthropic.claude-opus-4-6-v1",
	name: "Review",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1000000,
	maxTokens: 32000,
};
describe("Bedrock usage accounting", () => {
	it("prices reported one-hour cache writes separately", async () => {
		state.usage = {
			inputTokens: 100,
			outputTokens: 200,
			cacheReadInputTokens: 0,
			cacheWriteInputTokens: 1000000,
			totalTokens: 1000300,
			cacheDetails: [
				{ ttl: "1h", inputTokens: 400000 },
				{ ttl: "5m", inputTokens: 600000 },
			],
		};
		const result = await stream(model, { messages: [] }, { region: "us-east-1", cacheRetention: "long" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheWrite1h).toBe(400000);
		expect(result.usage.cost.cacheWrite).toBe(7.75);
	});
	it("includes cache buckets when the provider total is missing", async () => {
		state.usage = { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 5000, cacheWriteInputTokens: 1000 };
		const result = await stream(model, { messages: [] }, { region: "us-east-1" }).result();
		expect(result.stopReason).toBe("stop");
		expect(result.usage.totalTokens).toBe(6300);
	});
});
