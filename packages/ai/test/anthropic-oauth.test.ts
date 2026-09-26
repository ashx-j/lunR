import { describe, expect, it } from "vitest";
import { stream as directMessages } from "../src/api/anthropic-messages.ts";
import { ANTHROPIC_SETUP_REQUIRED, anthropicRequestRoute } from "../src/auth/anthropic-route.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { isQualifiedClaudeCodeVersion } from "../src/auth/oauth/anthropic.ts";
import type { AuthContext, ExternalClaudeCodeCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";

const connection: ExternalClaudeCodeCredential = {
	type: "external_claude_code",
	version: 1,
	manager: "claude-code",
	python: "python3",
	command: "/opt/claude",
	accountFingerprint: "test-account",
	routes: ["claude-sonnet-5[1m]"],
};

function configured(env: Record<string, string> = {}) {
	const credentials = new InMemoryCredentialStore();
	const authContext: AuthContext = { env: async (name) => env[name], fileExists: async () => false };
	const models = createModels({ credentials, authContext });
	models.setProvider(anthropicProvider());
	return { credentials, models };
}

describe("Anthropic subscription route", () => {
	it("accepts only the qualified Claude Code version", () => {
		expect(isQualifiedClaudeCodeVersion("2.1.263 (Claude Code)")).toBe(true);
		expect(isQualifiedClaudeCodeVersion("2.1.2630")).toBe(false);
		expect(isQualifiedClaudeCodeVersion("2.1.263-dev")).toBe(false);
	});

	it("preserves API-key HTTP auth and selects the external route only for the external record", async () => {
		const { credentials, models } = configured();
		await credentials.modify("anthropic", async () => connection);
		const resolution = await models.getAuth("anthropic");
		expect(resolution?.auth).toEqual({ externalClaudeCode: connection });
		expect(anthropicRequestRoute("anthropic", resolution!, undefined)).toEqual({ externalClaudeCode: connection });
		expect((await models.getAvailable("anthropic")).map((model) => model.id)).toContain("claude-sonnet-5");
		expect((await models.getAvailable("anthropic")).map((model) => model.id)).not.toContain("claude-opus-4-8");
		expect((await models.getAuth("anthropic", { apiKey: "sk-ant-api-key" }))?.auth.apiKey).toBe("sk-ant-api-key");
	});

	it("routes an ambient genuine API key to HTTP even with a stored subscription connection", async () => {
		const { credentials, models } = configured({ ANTHROPIC_API_KEY: "sk-ant-ambient" });
		await credentials.modify("anthropic", async () => connection);
		expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-ambient");
		expect((await models.checkAuth("anthropic"))?.type).toBe("api_key");
		expect((await models.getAvailable("anthropic")).map((model) => model.id)).toContain("claude-opus-4-8");
	});

	it("rejects legacy stored and ambient OAuth without refreshing or sending HTTP", async () => {
		const { credentials, models } = configured();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: "sk-ant-oat-old",
			refresh: "old",
			expires: 0,
		}));
		await expect(models.getAuth("anthropic")).rejects.toThrow(ANTHROPIC_SETUP_REQUIRED);
		expect(await models.checkAuth("anthropic")).toBeUndefined();
		await credentials.delete("anthropic");
		const ambient = configured({ ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-ambient" });
		await expect(ambient.models.getAuth("anthropic")).rejects.toThrow(ANTHROPIC_SETUP_REQUIRED);
		await expect(models.getAuth("anthropic", { apiKey: "sk-ant-oat-direct" })).rejects.toThrow(
			ANTHROPIC_SETUP_REQUIRED,
		);
	});

	it("rejects key-shaped legacy OAuth even at the direct Messages API entry point", async () => {
		const model = anthropicProvider().getModels()[0]!;
		const result = await directMessages(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
			{ apiKey: "sk-ant-oat-legacy" },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("requires Claude Code");
		const bearer = await directMessages(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
			{ headers: { authorization: "Bearer sk-ant-oat-legacy" } },
		).result();
		expect(bearer.stopReason).toBe("error");
		expect(bearer.errorMessage).toContain("requires Claude Code");
		const modelHeader = await directMessages(
			{ ...model, headers: { "x-api-key": "sk-ant-oat-legacy" } },
			{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
		).result();
		expect(modelHeader.stopReason).toBe("error");
	});

	it("rejects low-level mutations on the subscription route", () => {
		const resolution = { auth: { externalClaudeCode: connection } };
		expect(anthropicRequestRoute("anthropic", resolution, { headers: {} })).toEqual({
			externalClaudeCode: connection,
		});
		expect(() => anthropicRequestRoute("anthropic", resolution, { headers: { authorization: "unsafe" } })).toThrow(
			"custom headers",
		);
		expect(() =>
			anthropicRequestRoute("anthropic", resolution, { transformHeaders: async (headers) => headers }),
		).toThrow("custom headers");
	});
});
