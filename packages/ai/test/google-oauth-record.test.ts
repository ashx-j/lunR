import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { GOOGLE_SIGN_IN_REMOVED } from "../src/auth/resolve.ts";
import type { AuthContext, OAuthCredential } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { googleProvider } from "../src/providers/google.ts";

// lunR never shipped Google sign-in, but an OAuth record from an older tool can sit in auth.json.
const record: OAuthCredential = { type: "oauth", refresh: "refresh", access: "access", expires: 1 };

async function configured(env: Record<string, string>) {
	const credentials = new InMemoryCredentialStore();
	const authContext: AuthContext = { env: async (name) => env[name], fileExists: async () => false };
	const models = createModels({ credentials, authContext });
	models.setProvider(googleProvider());
	await credentials.modify("google", async () => record);
	return { credentials, models };
}

describe("saved Google OAuth record", () => {
	it("is skipped so a Gemini API key still works", async () => {
		const { credentials, models } = await configured({ GEMINI_API_KEY: "gemini-key" });
		expect((await models.getAuth("google"))?.auth.apiKey).toBe("gemini-key");
		expect((await models.checkAuth("google"))?.type).toBe("api_key");
		expect(await credentials.read("google")).toEqual(record);
	});

	it("explains in one line that Google sign-in is gone when no API key is set", async () => {
		const { credentials, models } = await configured({});
		expect(await models.checkAuth("google")).toBeUndefined();
		await expect(models.getAuth("google")).rejects.toThrow(GOOGLE_SIGN_IN_REMOVED);
		expect(GOOGLE_SIGN_IN_REMOVED).not.toContain("\n");
		expect(await credentials.read("google")).toEqual(record);
	});
});
