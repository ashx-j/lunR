import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_CLOUD_MODELS } from "./qwen-cloud.models.ts";

export function qwenCloudProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-cloud",
		name: "Qwen Cloud",
		baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		auth: {
			apiKey: envApiKeyAuth("Qwen Cloud API key", ["DASHSCOPE_API_KEY", "QWEN_CLOUD_API_KEY"]),
		},
		models: Object.values(QWEN_CLOUD_MODELS),
		api: openAICompletionsApi(),
	});
}
