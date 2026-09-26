import type { ModelsStreamTransforms } from "../models.ts";
import type { StreamOptions } from "../types.ts";
import { ModelsError } from "./resolve.ts";
import type { AuthResult } from "./types.ts";

export const ANTHROPIC_SETUP_REQUIRED =
	"Anthropic subscription authentication now requires Claude Code. Run /login anthropic and choose the subscription option. Direct OAuth tokens are no longer supported.";

export function isAnthropicOAuthToken(value: string | undefined): boolean {
	return !!value && (value.includes("sk-ant-oat") || value.startsWith("sk-ant-oauth"));
}

export function anthropicRequestRoute(
	provider: string,
	resolution: AuthResult,
	options: (StreamOptions & ModelsStreamTransforms) | undefined,
): Pick<StreamOptions, "apiKey" | "externalClaudeCode"> {
	if (provider !== "anthropic") return { apiKey: options?.apiKey ?? resolution.auth.apiKey };
	const apiKey = options?.apiKey ?? resolution.auth.apiKey;
	if (isAnthropicOAuthToken(apiKey)) throw new ModelsError("auth", ANTHROPIC_SETUP_REQUIRED);
	if (resolution.auth.externalClaudeCode && !apiKey) {
		if (
			Object.keys(options?.headers ?? {}).length ||
			options?.onPayload ||
			options?.onResponse ||
			options?.transformHeaders ||
			options?.env ||
			Object.keys(resolution.auth.headers ?? {}).length
		) {
			throw new ModelsError(
				"auth",
				"Claude Code subscription requests do not support custom headers, payload hooks, or environment overrides",
			);
		}
		return { externalClaudeCode: resolution.auth.externalClaudeCode };
	}
	return { apiKey };
}
