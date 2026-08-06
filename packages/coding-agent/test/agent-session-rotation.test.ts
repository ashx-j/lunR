import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SubscriptionManager } from "../src/core/subscriptions.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

const QUOTA_ERROR = "Monthly usage limit reached";

describe("AgentSession subscription rotation", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `lunr-rotation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options: {
		/** Error message each failing call produces; undefined = succeed. */
		failures: (string | undefined)[];
		pool?: { active: string; keys: { id: string; name: string; key: string; addedAt: number }[] };
		runtimeApiKey?: string;
	}) {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "key-1",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				// Calls beyond the failure list succeed.
				const failure = options.failures[callCount];
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (failure !== undefined) {
						const msg = createAssistantMessage("", { stopReason: "error", errorMessage: failure });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "key-1" }));
		const subscriptions = SubscriptionManager.inMemory(authStorage, options.pool ? { anthropic: options.pool } : {});
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
			subscriptions,
		});
		if (options.runtimeApiKey) {
			await modelRuntime.setRuntimeApiKey("anthropic", options.runtimeApiKey);
		}

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => events.push(event));
		return { session, authStorage, events, getCallCount: () => callCount };
	}

	const twoKeyPool = () => ({
		active: "1",
		keys: [
			{ id: "1", name: "Sub 1", key: "key-1", addedAt: 0 },
			{ id: "2", name: "Sub 2", key: "key-2", addedAt: 0 },
		],
	});

	it("rotates to the second key on a usage-limit error and retries the run", async () => {
		const created = await createSession({ failures: [QUOTA_ERROR], pool: twoKeyPool() });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		const rotations = created.events.filter((event) => event.type === "subscription_rotation");
		expect(rotations).toHaveLength(1);
		expect(rotations[0]).toMatchObject({ providerId: "anthropic", keyName: "Sub 2" });
		// The rotated key is mirrored into the auth store.
		expect(await created.authStorage.read("anthropic")).toEqual({ type: "api_key", key: "key-2" });
		// The error message was dropped from agent state; the run finished with the success message.
		const messages = created.session.agent.state.messages;
		const last = messages[messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("stop");
	});

	it("leaves the error as final when all keys are exhausted", async () => {
		// Both keys fail: the first failure rotates to Sub 2, the second finds no alternative.
		const created = await createSession({ failures: [QUOTA_ERROR, QUOTA_ERROR], pool: twoKeyPool() });

		await created.session.prompt("Test");

		const rotations = created.events.filter((event) => event.type === "subscription_rotation");
		expect(rotations).toHaveLength(1);
		// Final assistant message stays an error (goal usage_limited parking applies unchanged).
		const messages = created.session.agent.state.messages;
		const last = messages[messages.length - 1];
		expect(last?.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("error");
		expect((last as AssistantMessage).errorMessage).toBe(QUOTA_ERROR);
		// The last-active key stays mirrored in the auth store.
		expect(await created.authStorage.read("anthropic")).toEqual({ type: "api_key", key: "key-2" });
	});

	it("does not rotate for a single-key provider", async () => {
		const created = await createSession({ failures: [QUOTA_ERROR] });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(created.events.filter((event) => event.type === "subscription_rotation")).toHaveLength(0);
		const messages = created.session.agent.state.messages;
		const last = messages[messages.length - 1];
		expect((last as AssistantMessage).stopReason).toBe("error");
		expect(await created.authStorage.read("anthropic")).toEqual({ type: "api_key", key: "key-1" });
	});

	it("skips rotation when a runtime --api-key override is active", async () => {
		const created = await createSession({
			failures: [QUOTA_ERROR],
			pool: twoKeyPool(),
			runtimeApiKey: "override-key",
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(1);
		expect(created.events.filter((event) => event.type === "subscription_rotation")).toHaveLength(0);
		// auth.json is untouched — the override shadows it.
		expect(await created.authStorage.read("anthropic")).toEqual({ type: "api_key", key: "key-1" });
	});
});
