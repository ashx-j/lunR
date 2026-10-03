import { type AuthType, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SubscriptionManager, subscriptionKeyFingerprint } from "../src/core/subscriptions.ts";

function authOptions(runtime: ModelRuntime, type?: AuthType) {
	return runtime
		.getProviders()
		.flatMap((provider) => [
			...(!type || type === "oauth"
				? provider.auth.oauth
					? [{ type: "oauth" as const, provider, method: provider.auth.oauth }]
					: []
				: []),
			...(!type || type === "api_key"
				? provider.auth.apiKey
					? [{ type: "api_key" as const, provider, method: provider.auth.apiKey }]
					: []
				: []),
		]);
}

function testModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}

describe("ModelRuntime auth options", () => {
	it("accepts a pi-ai CredentialStore", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "stored-key" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("stored-key");
	});

	it("scopes provider availability reads and records refresh failures", async () => {
		const base = new InMemoryCredentialStore();
		const reads: string[] = [];
		let failReads = false;
		const credentials: CredentialStore = {
			read: async (providerId) => {
				reads.push(providerId);
				if (failReads) throw new Error(`read failed for ${providerId}`);
				return base.read(providerId);
			},
			list: () => base.list(),
			modify: (providerId, fn) => base.modify(providerId, fn),
			delete: (providerId) => base.delete(providerId),
		};
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });

		reads.length = 0;
		await runtime.getAvailable("anthropic");
		expect(new Set(reads)).toEqual(new Set(["anthropic"]));

		failReads = true;
		await expect(runtime.getAvailable("anthropic")).rejects.toThrow("Credential store read failed for anthropic");
		expect(runtime.getError()).toContain("Availability refresh: Credential store read failed for anthropic");

		failReads = false;
		await runtime.getAvailable();
		expect(runtime.getError()).toBeUndefined();
	});

	it("projects provider-owned methods, names, and status", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const options = authOptions(runtime);

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "amazon-bedrock", name: "Amazon Bedrock" }),
					method: expect.objectContaining({ name: "AWS credentials or bearer token" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "google-vertex", name: "Google Vertex AI" }),
					method: expect.objectContaining({ name: "Google Cloud credentials" }),
				}),
				expect.objectContaining({
					type: "oauth",
					provider: expect.objectContaining({ id: "anthropic", name: "Anthropic" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway" }),
				}),
				expect.objectContaining({
					type: "api_key",
					provider: expect.objectContaining({ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI" }),
				}),
			]),
		);
		expect(authOptions(runtime, "api_key").every((option) => option.type === "api_key")).toBe(true);
		expect(authOptions(runtime, "oauth").every((option) => option.type === "oauth")).toBe(true);
		expect(options.some((option) => option.provider.id === "openai-codex" && option.type === "api_key")).toBe(false);
	});

	it("attaches the provider's active auth status to every method option", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "external_claude_code",
					version: 1,
					manager: "claude-code",
					python: "python",
					command: "claude",
				},
			}),
			modelsPath: null,
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "anthropic");
		expect(options).toHaveLength(2);
		expect(await runtime.checkAuth("anthropic")).toMatchObject({ type: "oauth" });
	});

	it("rejects custom headers before a Claude Code subscription request starts", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				anthropic: {
					type: "external_claude_code",
					version: 1,
					manager: "claude-code",
					python: "python",
					command: "claude",
				},
			}),
			modelsPath: null,
		});
		const model = runtime.getModel("anthropic", "claude-sonnet-5");
		expect(model).toBeDefined();
		const response = await runtime.completeSimple(
			model!,
			{
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			},
			{ headers: { authorization: "nope" } },
		);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toContain("custom headers");
	});

	it("constructs an API key method for an extension API-key provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-api-key", {
			name: "Extension API Key",
			baseUrl: "https://example.test/v1",
			apiKey: "$EXTENSION_TEST_API_KEY",
			api: "openai-completions",
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-api-key");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "api_key",
			provider: { id: "extension-api-key", name: "Extension API Key" },
			method: { name: "API key" },
		});
		expect(options[0]?.method.login).toBeTypeOf("function");
	});

	it("resolves configured auth from request-scoped environment overrides", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("request-env-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "$REQUEST_SCOPED_API_KEY",
			headers: { "x-request-value": "$REQUEST_SCOPED_HEADER" },
			api: "openai-completions",
			models: [testModel("request-env-model")],
		});

		const auth = await runtime.getAuth("request-env-provider", {
			env: { REQUEST_SCOPED_API_KEY: "request-key", REQUEST_SCOPED_HEADER: "request-header" },
		});

		expect(auth?.auth).toEqual({ apiKey: "request-key", headers: { "x-request-value": "request-header" } });
	});

	it("lets an explicit Authorization header override authHeader case-insensitively", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		runtime.registerProvider("auth-header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [testModel("auth-header-model")],
		});
		const model = runtime.getModel("auth-header-provider", "auth-header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] }, { headers: { authorization: "Explicit token" } });

		expect(capturedHeaders).toEqual({ authorization: "Explicit token" });
	});

	it("transforms fully assembled headers once without forwarding the transform", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		let capturedHeaders: Record<string, string | null> | undefined;
		let transforms = 0;
		runtime.registerProvider("header-provider", {
			baseUrl: "https://example.test/v1",
			apiKey: "generated-key",
			authHeader: true,
			headers: { "x-provider": "provider" },
			api: "openai-completions",
			streamSimple: (_model, _context, options) => {
				expect(options).not.toHaveProperty("transformHeaders");
				capturedHeaders = options?.headers;
				throw new Error("captured");
			},
			models: [{ ...testModel("header-model"), headers: { "x-model": "model" } }],
		});
		const model = runtime.getModel("header-provider", "header-model");
		expect(model).toBeDefined();

		await runtime.completeSimple(
			model!,
			{ messages: [] },
			{
				headers: { "x-explicit": "explicit" },
				transformHeaders: async (headers) => {
					transforms++;
					expect(headers).toEqual({
						Authorization: "Bearer generated-key",
						"x-provider": "provider",
						"x-model": "model",
						"x-explicit": "explicit",
					});
					return { ...headers, "x-transformed": "yes" };
				},
			},
		);

		expect(transforms).toBe(1);
		expect(capturedHeaders).toEqual({
			Authorization: "Bearer generated-key",
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-transformed": "yes",
		});
	});

	it("does not fabricate an API key method for an extension OAuth-only provider", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		runtime.registerProvider("extension-oauth", {
			name: "Extension OAuth",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Extension subscription",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
			models: [testModel("extension-model")],
		});

		const options = authOptions(runtime).filter((option) => option.provider.id === "extension-oauth");
		expect(options).toHaveLength(1);
		expect(options[0]).toMatchObject({
			type: "oauth",
			provider: { id: "extension-oauth", name: "Extension OAuth" },
			method: { name: "Extension subscription" },
		});
	});
});

describe("stored API-key environment propagation", () => {
	it("uses stored env for model headers and stream options and allows explicit overrides", async () => {
		const env = { STORED_MODEL_HEADER: "fake-stored", CACHE_RETENTION: "long" };
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ openai: { type: "api_key", key: "fake-key", env } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let captured: { env?: Record<string, string>; headers?: Record<string, string | null> } | undefined;
		runtime.registerProvider("openai", {
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			models: [{ ...testModel("fake-env-model"), headers: { "x-model": "$STORED_MODEL_HEADER" } }],
			streamSimple: (_model, _context, options) => {
				captured = options;
				throw new Error("fake captured transport");
			},
		});
		const model = runtime.getModel("openai", "fake-env-model")!;
		expect((await runtime.getAuth(model))?.env).toEqual(env);
		expect((await runtime.getAuth(model))?.auth.headers).toMatchObject({ "x-model": "fake-stored" });
		await runtime.completeSimple(model, { messages: [] }, { env: { STORED_MODEL_HEADER: "fake-request" } });
		expect(captured?.env).toEqual({ ...env, STORED_MODEL_HEADER: "fake-request" });
		expect(captured?.headers).toMatchObject({ "x-model": "fake-request" });
	});
});

describe("request credential identity", () => {
	async function runtimeWithCredential(stored = true, authHeader = false) {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(stored ? { anthropic: { type: "api_key", key: "stored-key" } } : {}),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let requestKey: string | undefined;
		runtime.registerProvider("anthropic", {
			api: "anthropic-messages",
			authHeader,
			streamSimple: (_model, _context, options) => {
				requestKey = options?.apiKey;
				throw new Error("fake quota transport failure");
			},
		});
		const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
		return { runtime, model, requestKey: () => requestKey };
	}

	it.each(["stream", "streamSimple"] as const)(
		"tracks the exact final %s response without serializing its identity",
		async (method) => {
			const { runtime, model, requestKey } = await runtimeWithCredential(true, true);
			const stream = runtime[method](model, { messages: [] });
			const message = await stream.result();
			expect(requestKey()).toBe("stored-key");
			expect(runtime.getRequestSubscriptionKey(message)).toEqual({
				providerId: "anthropic",
				fingerprint: subscriptionKeyFingerprint("anthropic", "stored-key"),
			});
			expect(runtime.getRequestSubscriptionKey({ ...message })).toBeUndefined();
			expect(JSON.stringify(message)).not.toContain("stored-key");
			expect(JSON.stringify(message)).not.toContain("fingerprint");
		},
	);

	it("keeps the resolved key when credential state changes during header preparation", async () => {
		const { runtime, model, requestKey } = await runtimeWithCredential();
		const message = await runtime.completeSimple(
			model,
			{ messages: [] },
			{
				transformHeaders: async (headers) => {
					await runtime.setRuntimeApiKey("anthropic", "later-override");
					await runtime.removeRuntimeApiKey("anthropic");
					return headers;
				},
			},
		);
		expect(requestKey()).toBe("stored-key");
		expect(runtime.getRequestSubscriptionKey(message)?.fingerprint).toBe(
			subscriptionKeyFingerprint("anthropic", "stored-key"),
		);
	});

	it("keeps overlapping stored resolutions isolated and preserves each credential's environment", async () => {
		const credentials = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "key-a", env: { TEST_ENV: "a" } },
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const seen: { apiKey?: string; env?: Record<string, string> }[] = [];
		runtime.registerProvider("anthropic", {
			api: "anthropic-messages",
			streamSimple: (_model, _context, options) => {
				seen.push(options ?? {});
				throw new Error("fake quota failure");
			},
		});
		const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
		let release!: () => void;
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read = credentials.read.bind(credentials);
		let reads = 0;
		vi.spyOn(credentials, "read").mockImplementation(async (provider) => {
			const credential = await read(provider);
			if (provider === "anthropic" && ++reads === 1) {
				started();
				await ready;
			}
			return credential;
		});
		const first = runtime.completeSimple(model, { messages: [] });
		await requestStarted;
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "key-b", env: { TEST_ENV: "b" } }));
		const second = await runtime.completeSimple(model, { messages: [] });
		release();
		const old = await first;
		expect(runtime.getRequestSubscriptionKey(old)?.fingerprint).toBe(
			subscriptionKeyFingerprint("anthropic", "key-a"),
		);
		expect(runtime.getRequestSubscriptionKey(second)?.fingerprint).toBe(
			subscriptionKeyFingerprint("anthropic", "key-b"),
		);
		expect(seen).toMatchObject([
			{ apiKey: "key-b", env: { TEST_ENV: "b" } },
			{ apiKey: "key-a", env: { TEST_ENV: "a" } },
		]);
	});

	it("does not qualify configured environment fallback just because it matches a retained pool", async () => {
		const credentials = AuthStorage.inMemory();
		const subscriptions = SubscriptionManager.inMemory(credentials, {
			anthropic: {
				active: "1",
				keys: [
					{ id: "1", name: "retained", key: "env-key", addedAt: 0 },
					{ id: "2", name: "other", key: "other-key", addedAt: 0 },
				],
			},
		});
		const runtime = await ModelRuntime.create({
			credentials,
			subscriptions,
			modelsPath: null,
			allowModelNetwork: false,
		});
		let requestKey: string | undefined;
		runtime.registerProvider("anthropic", {
			api: "anthropic-messages",
			apiKey: "$CONFIGURED_TEST_KEY",
			streamSimple: (_model, _context, options) => {
				requestKey = options?.apiKey;
				throw new Error("fake quota failure");
			},
		});
		const model = runtime.getModel("anthropic", "claude-sonnet-4-5")!;
		const message = await runtime.completeSimple(
			model,
			{ messages: [] },
			{ env: { CONFIGURED_TEST_KEY: "env-key" } },
		);
		expect(requestKey).toBe("env-key");
		expect(runtime.getRequestSubscriptionKey(message)).toBeUndefined();
		expect(await subscriptions.getActive("anthropic")).toMatchObject({ id: "1" });
		expect(await credentials.read("anthropic")).toBeUndefined();
	});

	it("does not assign a stored-pool identity to explicit keys or replacement auth headers", async () => {
		const { runtime, model } = await runtimeWithCredential(true, true);
		for (const options of [
			{ apiKey: "stored-key" },
			{ headers: { authorization: "Bearer foreign-key" } },
			{ transformHeaders: async () => ({ "x-api-key": "foreign-key" }) },
		]) {
			const message = await runtime.completeSimple(model, { messages: [] }, options);
			expect(runtime.getRequestSubscriptionKey(message)).toBeUndefined();
		}
	});

	it("does not mistake a removed runtime override or env-only credential for a stored key", async () => {
		const { runtime, model, requestKey } = await runtimeWithCredential();
		await runtime.setRuntimeApiKey("anthropic", "override-key");
		const override = await runtime.completeSimple(
			model,
			{ messages: [] },
			{
				transformHeaders: async (headers) => {
					await runtime.removeRuntimeApiKey("anthropic");
					return headers;
				},
			},
		);
		expect(requestKey()).toBe("override-key");
		expect(runtime.getRequestSubscriptionKey(override)).toBeUndefined();
		const ambient = await runtimeWithCredential(false);
		const env = await ambient.runtime.completeSimple(
			ambient.model,
			{ messages: [] },
			{ env: { ANTHROPIC_API_KEY: "env-key" } },
		);
		expect(ambient.requestKey()).toBe("env-key");
		expect(ambient.runtime.getRequestSubscriptionKey(env)).toBeUndefined();
	});
});
