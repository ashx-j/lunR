import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import intercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";
import { deliverSubagentIntercomMessageEvent } from "../src/builtin-extensions/pi-subagents/src/intercom/result-intercom.ts";

vi.mock("../src/builtin-extensions/pi-intercom/config.ts", () => ({
	loadConfig: () => ({ enabled: true, inboundTrigger: "always" }),
	getAskTimeoutMs: () => 60_000,
}));
vi.mock("../src/builtin-extensions/pi-intercom/broker/spawn.ts", () => ({
	isNativeSupervisorChannelActive: () => false,
	spawnBrokerIfNeeded: () => new Promise(() => {}),
}));

afterEach(() => {
	vi.useRealTimers();
});

it("acknowledges a retry without redelivering a locally accepted result after the first ack was late", async () => {
	vi.useFakeTimers();
	const emitter = new EventEmitter();
	let firstAck = true;
	const events = {
		on(name: string, handler: (data: unknown) => void) {
			emitter.on(name, handler);
			return () => {
				emitter.off(name, handler);
			};
		},
		emit(name: string, data: unknown) {
			if (name === "subagent:result-intercom-delivery" && firstAck) {
				firstAck = false;
				setTimeout(() => emitter.emit(name, data), 750);
			} else emitter.emit(name, data);
		},
	};
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const sendMessage = vi.fn();
	const pi = {
		events,
		sendMessage,
		appendEntry: vi.fn(),
		getSessionName: () => "parent",
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerShortcut: vi.fn(),
		on: (name: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(name, handler);
		},
	};
	intercomExtension(pi as never);
	const ctx = {
		cwd: "test",
		model: { id: "test" },
		sessionManager: { getSessionId: () => "parent" },
		isIdle: () => true,
	};
	await handlers.get("session_start")!({}, ctx);
	try {
		const first = deliverSubagentIntercomMessageEvent(events, "parent", "result", 500, { requestId: "stable" });
		await vi.advanceTimersByTimeAsync(500);
		expect(await first).toBe(false);
		expect(await deliverSubagentIntercomMessageEvent(events, "parent", "result", 500, { requestId: "stable" })).toBe(
			true,
		);
		await vi.advanceTimersByTimeAsync(300);
		expect(sendMessage).toHaveBeenCalledOnce();
	} finally {
		await handlers.get("session_shutdown")!();
	}
});
