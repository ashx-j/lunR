import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/api/cloudflare.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

export function hasCloudflareWorkersAICredentials(): boolean {
	return !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID;
}

export function hasCloudflareAiGatewayCredentials(): boolean {
	return (
		!!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_GATEWAY_ID
	);
}

/** A Workers AI model behind the AI Gateway /compat endpoint, which the catalog does not list today. */
export function workersAiGatewayModel(): Model<"openai-completions"> {
	return {
		...getModel("cloudflare-workers-ai", "@cf/moonshotai/kimi-k2.6"),
		id: "workers-ai/@cf/moonshotai/kimi-k2.6",
		provider: "cloudflare-ai-gateway",
		baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	};
}
