import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { prepareRetry, type SessionRetryHost } from "../src/core/session-retry.ts";

function createHost(attempt: number) {
	const events: unknown[] = [];
	const host = {
		agent: { state: { messages: [{ role: "user" }, { role: "assistant" }] } },
		settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 10_000 }) },
		retryAttempt: attempt,
		retryAbortController: undefined as AbortController | undefined,
		emit: (event: unknown) => events.push(event),
	};
	return { host, events };
}

const failed = { role: "assistant", stopReason: "error", errorMessage: "overloaded" } as AssistantMessage;

describe("prepareRetry", () => {
	it("doubles the delay per attempt, drops the error reply, and reports a cancelled wait", async () => {
		const { host, events } = createHost(1);
		const pending = prepareRetry(host as unknown as SessionRetryHost, failed);
		expect(events).toEqual([
			{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 20_000, errorMessage: "overloaded" },
		]);
		expect(host.agent.state.messages).toEqual([{ role: "user" }]);
		host.retryAbortController?.abort();
		await expect(pending).resolves.toBe(false);
		expect(events.at(-1)).toEqual({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
			finalError: "Retry cancelled",
		});
		expect(host.retryAttempt).toBe(0);
		expect(host.retryAbortController).toBeUndefined();
	});

	it("keeps the attempt count and emits nothing once retries are used up", async () => {
		const { host, events } = createHost(3);
		await expect(prepareRetry(host as unknown as SessionRetryHost, failed)).resolves.toBe(false);
		expect(host.retryAttempt).toBe(3);
		expect(events).toEqual([]);
	});
});
