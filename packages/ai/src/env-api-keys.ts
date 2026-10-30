import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "anthropic") {
		return ["ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		zai: "ZAI_API_KEY",
		minimax: "MINIMAX_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
	return found.length > 0 ? found : undefined;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const envKeys = findEnvKeys(provider, env);
	return envKeys?.[0] ? getProviderEnvValue(envKeys[0], env) : undefined;
}
