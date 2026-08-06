import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_CLOUD_CN_MODELS } from "./qwen-cloud-cn.models.ts";

export function qwenCloudCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-cloud-cn",
		name: "Qwen Cloud CN",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		auth: {
			apiKey: envApiKeyAuth("Qwen Cloud CN API key", ["DASHSCOPE_API_KEY", "QWEN_CLOUD_API_KEY"]),
		},
		models: Object.values(QWEN_CLOUD_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
