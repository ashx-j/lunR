import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeSession } from "../src/gateway/agent-bridge.ts";
import { AgentBridge, QUEUED } from "../src/gateway/agent-bridge.ts";
import type { MessageEvent, SessionSource } from "../src/gateway/types.ts";

function fakeSession(dispose = vi.fn(), onShutdown?: (event: unknown) => void): BridgeSession {
	return {
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
		subscribe: () => () => {},
		state: { messages: [] },
		extensionRunner: {
			hasHandlers: () => true,
			emit: vi.fn(async (event: unknown) => onShutdown?.(event)),
		},
		dispose,
		isStreaming: false,
		modelRuntime: {} as unknown as BridgeSession["modelRuntime"],
		thinkingLevel: "off",
		messages: [],
		systemPrompt: "",
		getActiveToolNames: () => [],
		getToolDefinition: () => undefined,
		getAvailableThinkingLevels: () => ["off"],
		supportsThinking: () => false,
		setThinkingLevel: () => {},
		setModel: vi.fn().mockResolvedValue(undefined),
		compact: vi.fn().mockResolvedValue({} as unknown as Awaited<ReturnType<BridgeSession["compact"]>>),
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		getContextUsage: () => undefined,
		getSessionStats: () => ({}) as unknown as ReturnType<BridgeSession["getSessionStats"]>,
		setSessionName: () => {},
	};
}

function makeEvent(key: string): MessageEvent {
	return {
		text: `hello ${key}`,
		messageId: "msg1",
		source: {
			platform: "telegram",
			chatId: key,
			chatType: "dm",
			userId: "u1",
		} as SessionSource,
	};
}

describe("AgentBridge LRU eviction", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("evicts the oldest idle session after emitting session_shutdown", async () => {
		const sessions = new Map<string, BridgeSession>();
		const lifecycle: string[] = [];
		const bridge = new AgentBridge({
			cacheCap: 2,
			sessionFactory: async (key) => {
				if (!sessions.has(key)) {
					sessions.set(
						key,
						fakeSession(
							vi.fn(() => lifecycle.push(`${key}:dispose`)),
							(event) =>
								lifecycle.push(
									`${key}:${(event as { type: string; reason: string }).type}:${(event as { reason: string }).reason}`,
								),
						),
					);
				}
				return sessions.get(key)!;
			},
		});

		await bridge.runTurn("k1", makeEvent("k1"));
		await bridge.runTurn("k2", makeEvent("k2"));
		await bridge.runTurn("k3", makeEvent("k3"));

		expect(sessions.get("k1")?.dispose).toHaveBeenCalled();
		expect(lifecycle).toEqual(["k1:session_shutdown:quit", "k1:dispose"]);
		expect(sessions.get("k2")?.dispose).not.toHaveBeenCalled();
		expect(sessions.get("k3")?.dispose).not.toHaveBeenCalled();
	});

	it("does not evict a busy session; it evicts the next idle session instead", async () => {
		const sessions = new Map<string, BridgeSession>();
		let releaseK1: (() => void) | undefined;
		sessions.set("k1", {
			...fakeSession(),
			prompt: () =>
				new Promise<void>((resolve) => {
					releaseK1 = resolve;
				}),
		});

		const bridge = new AgentBridge({
			cacheCap: 2,
			sessionFactory: async (key) => {
				if (!sessions.has(key)) sessions.set(key, fakeSession());
				return sessions.get(key)!;
			},
		});

		const turn1 = bridge.runTurn("k1", makeEvent("k1"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(bridge.getStatus("k1").busy).toBe(true);

		await bridge.runTurn("k2", makeEvent("k2"));
		await bridge.runTurn("k3", makeEvent("k3"));

		expect(sessions.get("k1")?.dispose).not.toHaveBeenCalled();
		expect(sessions.get("k2")?.dispose).toHaveBeenCalled();
		expect(sessions.get("k3")?.dispose).not.toHaveBeenCalled();

		releaseK1?.();
		await turn1;
	});

	it("grows the cap when every cached session is busy", async () => {
		const sessions = new Map<string, BridgeSession>();
		const releases: Array<() => void> = [];
		for (const key of ["k1", "k2"]) {
			sessions.set(key, {
				...fakeSession(),
				prompt: () => new Promise<void>((resolve) => releases.push(resolve)),
			});
		}

		const bridge = new AgentBridge({
			cacheCap: 2,
			sessionFactory: async (key) => {
				if (!sessions.has(key)) sessions.set(key, fakeSession());
				return sessions.get(key)!;
			},
		});

		for (const key of ["k1", "k2"]) {
			bridge.runTurn(key, makeEvent(key));
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		await bridge.runTurn("k3", makeEvent("k3"));

		expect(bridge.getStatus("k1").busy).toBe(true);
		expect(bridge.getStatus("k2").busy).toBe(true);
		expect(bridge.getStatus("k3").busy).toBe(false);
		for (const [, session] of sessions) {
			expect(session.dispose).not.toHaveBeenCalled();
		}

		for (const release of releases) release();
	});

	it("queues messages for a busy session instead of creating a new one", async () => {
		let release: (() => void) | undefined;
		const session = {
			...fakeSession(),
			prompt: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		};
		const factory = vi.fn().mockResolvedValue(session);
		const bridge = new AgentBridge({ cacheCap: 2, sessionFactory: factory });

		const first = bridge.runTurn("k1", makeEvent("k1"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		const queued = await bridge.runTurn("k1", makeEvent("k1 follow-up"));
		expect(queued).toBe(QUEUED);
		expect(bridge.getStatus("k1").queueDepth).toBe(1);

		release?.();
		await first;
	});

	it("reset aborts a busy session, emits shutdown, drops the queue, then disposes", async () => {
		let release: (() => void) | undefined;
		const lifecycle: string[] = [];
		const session = {
			...fakeSession(
				vi.fn(() => lifecycle.push("dispose")),
				(event) =>
					lifecycle.push(
						`${(event as { type: string; reason: string }).type}:${(event as { reason: string }).reason}`,
					),
			),
			prompt: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		};
		const bridge = new AgentBridge({
			cacheCap: 2,
			sessionFactory: async () => session,
		});

		const first = bridge.runTurn("k1", makeEvent("k1"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		await bridge.runTurn("k1", makeEvent("k1 follow-up"));
		expect(bridge.getStatus("k1").busy).toBe(true);
		expect(bridge.getStatus("k1").queueDepth).toBe(1);

		await bridge.reset("k1");

		expect(session.abort).toHaveBeenCalled();
		expect(session.dispose).toHaveBeenCalled();
		expect(lifecycle).toEqual(["session_shutdown:new", "dispose"]);
		expect(bridge.getStatus("k1").busy).toBe(false);
		expect(bridge.getStatus("k1").queueDepth).toBe(0);

		release?.();
		await first.catch(() => {});
	});

	it("emits resume shutdown with the target before switching sessions", async () => {
		const events: unknown[] = [];
		const oldSession = fakeSession(undefined, (event) => events.push(event));
		const replacement = fakeSession();
		const factory = vi.fn().mockResolvedValueOnce(oldSession).mockResolvedValueOnce(replacement);
		const bridge = new AgentBridge({ sessionFactory: factory });
		await bridge.runTurn("k1", makeEvent("k1"));

		await bridge.switchSession("k1", "target.jsonl");

		expect(events).toEqual([{ type: "session_shutdown", reason: "resume", targetSessionFile: "target.jsonl" }]);
		expect(oldSession.dispose).toHaveBeenCalled();
	});

	it("still disposes when a shutdown handler throws", async () => {
		const dispose = vi.fn();
		const session = fakeSession(dispose, () => {
			throw new Error("shutdown failed");
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const bridge = new AgentBridge({ sessionFactory: async () => session });
		await bridge.runTurn("k1", makeEvent("k1"));

		await expect(bridge.reset("k1")).resolves.toBeUndefined();
		expect(dispose).toHaveBeenCalled();
		expect(error).toHaveBeenCalled();
	});
});

describe("headless factory wiring", () => {
	it("binds runtime bridges after gateway and cron session create", () => {
		const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/gateway");
		expect(readFileSync(join(dir, "agent-bridge.ts"), "utf8")).toContain("bindRuntimeBridges({ session, services })");
		expect(readFileSync(join(dir, "cron.ts"), "utf8")).toContain("bindRuntimeBridges({ session, services })");
	});
});
