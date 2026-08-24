import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUEUED, type TurnCallbacks } from "../src/gateway/agent-bridge.ts";
import { defaultGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import { type BridgeLike, createRouter } from "../src/gateway/router.ts";
import type { ButtonSpec, MessageEvent, PlatformAdapter, SendOptions, SendResult } from "../src/gateway/types.ts";

class FakeAdapter implements PlatformAdapter {
	readonly platform = "telegram";
	maxMessageLength = 100;
	sent: Array<{ chatId: string; text: string; opts?: SendOptions; buttons?: ButtonSpec[][] }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string; buttons?: ButtonSpec[][] }> = [];
	typing: string[] = [];
	callbackAnswers: Array<{ id: string; text?: string }> = [];

	async connect(): Promise<boolean> {
		return true;
	}
	async disconnect(): Promise<void> {}
	async send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts });
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async sendButtons(chatId: string, text: string, buttons: ButtonSpec[][], opts?: SendOptions): Promise<SendResult> {
		this.sent.push({ chatId, text, opts, buttons });
		return { success: true, messageId: `m${this.sent.length}` };
	}
	async editMessage(chatId: string, messageId: string, text: string, buttons?: ButtonSpec[][]): Promise<SendResult> {
		this.edits.push({ chatId, messageId, text, buttons });
		return { success: true };
	}
	async sendTyping(chatId: string): Promise<void> {
		this.typing.push(chatId);
	}
	onMessage(): void {}
	onCallback(): void {}
	async answerCallback(id: string, text?: string): Promise<void> {
		this.callbackAnswers.push({ id, text });
	}
}

class FakeBridge implements BridgeLike {
	results: Array<string | Error> = [];
	calls: Array<{ key: string; event: MessageEvent }> = [];
	aborted: string[] = [];
	resets: string[] = [];
	status = { busy: false, queueDepth: 0 };
	onRunTurn?: (callbacks: TurnCallbacks) => void | Promise<void>;

	async runTurn(key: string, event: MessageEvent, callbacks: TurnCallbacks): Promise<string> {
		this.calls.push({ key, event });
		await this.onRunTurn?.(callbacks);
		const result = this.results.shift() ?? "ok";
		if (result instanceof Error) throw result;
		return result;
	}
	async abort(key: string): Promise<void> {
		this.aborted.push(key);
	}
	reset(key: string): void {
		this.resets.push(key);
	}
	getStatus(): { busy: boolean; queueDepth: number } {
		return { ...this.status };
	}
	async getSession(): Promise<null> {
		return null;
	}
	async switchSession(): Promise<void> {}
	async undo(): Promise<{ userText: string }> {
		return { userText: "" };
	}
	async redo(): Promise<void> {}
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-router-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeConfig(mutate?: (cfg: GatewayConfig) => void): GatewayConfig {
	const cfg = defaultGatewayConfig();
	cfg.streaming.enabled = false; // deterministic; streaming has its own test
	cfg.telegram.allowedUsers = ["u1"];
	mutate?.(cfg);
	return cfg;
}

function makeDeps(cfg: GatewayConfig) {
	const adapter = new FakeAdapter();
	const bridge = new FakeBridge();
	const router = createRouter({
		adapters: new Map([["telegram", adapter]]),
		cfg,
		pairing: createPairingStore({ dir }),
		bridge,
	});
	return { adapter, bridge, router };
}

function dmEvent(text: string, userId = "u1"): MessageEvent {
	return {
		text,
		messageId: "msg1",
		source: { platform: "telegram", chatId: "chat1", chatType: "dm", userId },
	};
}

function groupEvent(text: string, overrides: Partial<MessageEvent["source"]> = {}, mentioned = false): MessageEvent {
	return {
		text,
		messageId: "msg1",
		source: { platform: "telegram", chatId: "chat1", chatType: "group", userId: "u1", ...overrides },
		metadata: mentioned ? { mentionedBot: true } : undefined,
	};
}

describe("router: group gating", () => {
	it("drops group messages outside allowedChats without a mention", async () => {
		const { adapter, bridge, router } = makeDeps(
			makeConfig((c) => {
				c.telegram.allowedChats = ["someone-else"];
			}),
		);
		await router.handleEvent(groupEvent("hello"));
		expect(adapter.sent).toEqual([]);
		expect(bridge.calls).toEqual([]);
	});

	it("lets explicit mentions through the allowedChats gate", async () => {
		const { bridge, router } = makeDeps(
			makeConfig((c) => {
				c.telegram.allowedChats = ["someone-else"];
			}),
		);
		await router.handleEvent(groupEvent("hello", {}, true));
		expect(bridge.calls).toHaveLength(1);
	});

	it("drops non-mentions when requireMention is on", async () => {
		const { adapter, bridge, router } = makeDeps(
			makeConfig((c) => {
				c.telegram.requireMention = true;
			}),
		);
		await router.handleEvent(groupEvent("hello"));
		expect(adapter.sent).toEqual([]);
		expect(bridge.calls).toEqual([]);
	});

	it("freeResponseChats bypass the mention requirement", async () => {
		const { bridge, router } = makeDeps(
			makeConfig((c) => {
				c.telegram.requireMention = true;
				c.telegram.freeResponseChats = ["chat1"];
			}),
		);
		await router.handleEvent(groupEvent("hello"));
		expect(bridge.calls).toHaveLength(1);
	});

	it("unknown slash commands in groups are ignored", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		await router.handleEvent(groupEvent("/unknown do stuff"));
		expect(adapter.sent).toEqual([]);
		expect(bridge.calls).toEqual([]);
	});
});

describe("router: authorization", () => {
	it("unauthorized DM gets a pairing code message; bridge is not called", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		await router.handleEvent(dmEvent("hi", "stranger"));
		expect(bridge.calls).toEqual([]);
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].text).toContain("Your lunR pairing code:");
		expect(adapter.sent[0].text).toContain("lunr gateway pair approve telegram");
		expect(adapter.sent[0].text).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
	});

	it("unauthorized DM stays silent when behavior is 'ignore'", async () => {
		const { adapter, router } = makeDeps(
			makeConfig((c) => {
				c.unauthorizedDmBehavior = "ignore";
			}),
		);
		await router.handleEvent(dmEvent("hi", "stranger"));
		expect(adapter.sent).toEqual([]);
	});

	it("unauthorized group messages are silent", async () => {
		const { adapter, router } = makeDeps(makeConfig());
		await router.handleEvent(groupEvent("hi", { userId: "stranger" }));
		expect(adapter.sent).toEqual([]);
	});
});

describe("router: normal path", () => {
	it("delivers a reply split to the platform limit, first chunk replying to the trigger", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.results = ["x".repeat(230)];
		await router.handleEvent(dmEvent("go"));
		expect(adapter.sent.length).toBeGreaterThan(1);
		for (const msg of adapter.sent) {
			expect(msg.text.length).toBeLessThanOrEqual(100);
		}
		expect(adapter.sent[0].opts?.replyTo).toBe("msg1");
		expect(adapter.sent[1].opts?.replyTo).toBeUndefined();
		expect(adapter.typing).toEqual(["chat1"]);
	});

	it("silence marker suppresses delivery", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.results = ["[SILENT]"];
		await router.handleEvent(dmEvent("go"));
		expect(adapter.sent).toEqual([]);
	});

	it("a trailing NO_REPLY line is stripped from the reply", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.results = ["the answer\nNO_REPLY"];
		await router.handleEvent(dmEvent("go"));
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].text).toBe("the answer");
	});

	it("queued sentinel produces no reply", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.results = [QUEUED];
		await router.handleEvent(dmEvent("go"));
		expect(adapter.sent).toEqual([]);
	});

	it("errors surface as a compact one-line warning", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.results = [new Error("boom")];
		await router.handleEvent(dmEvent("go"));
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].text).toBe("⚠ boom");
	});

	it("streams a preview via send+edit, then folds the final text INTO it (no double-send)", async () => {
		const { adapter, bridge, router } = makeDeps(
			makeConfig((c) => {
				c.streaming.enabled = true;
				c.streaming.editIntervalMs = 0;
				c.streaming.bufferThreshold = 10;
			}),
		);
		bridge.results = ["streamed final answer"];
		bridge.onRunTurn = async (callbacks) => {
			callbacks.onDelta?.("streamed "); // below threshold: no flush
			callbacks.onDelta?.("final "); // 15 chars: initial send
			// Let the throttled flush land before the next delta (real streams
			// arrive over time; synchronous pushes would coalesce into one flush).
			await new Promise((resolve) => setImmediate(resolve));
			callbacks.onDelta?.("answer"); // below threshold again: flushed by finalize as an edit
		};
		await router.handleEvent(dmEvent("go"));
		// Preview sent as a message replying to the trigger...
		expect(adapter.sent[0].opts?.replyTo).toBe("msg1");
		// ...and it is the ONLY message sent (no preview + final duplicate)...
		expect(adapter.sent).toHaveLength(1);
		// ...with the final text folded in as the last edit.
		expect(adapter.edits.length).toBeGreaterThan(0);
		expect(adapter.edits[adapter.edits.length - 1].text).toBe("streamed final answer");
	});

	it("upgrades a truncated preview to chunk 1 and sends the rest as follow-ups", async () => {
		const { adapter, bridge, router } = makeDeps(
			makeConfig((c) => {
				c.streaming.enabled = true;
				c.streaming.editIntervalMs = 0;
				c.streaming.bufferThreshold = 10;
			}),
		);
		// 150 chars > adapter maxMessageLength (100) → 2 chunks, truncated preview.
		const longResult = `${"a".repeat(90)} ${"b".repeat(59)}`;
		bridge.results = [longResult];
		bridge.onRunTurn = (callbacks) => {
			callbacks.onDelta?.(longResult);
		};
		await router.handleEvent(dmEvent("go"));
		// Preview (truncated) was the initial send; overflow chunk was sent after.
		expect(adapter.sent).toHaveLength(2);
		// The preview message was upgraded to the first full chunk via edit...
		expect(adapter.edits[adapter.edits.length - 1].text.endsWith(" (1/2)")).toBe(true);
		// ...and the remainder went out as a new message.
		expect(adapter.sent[1].text.endsWith(" (2/2)")).toBe(true);
		expect(adapter.sent[0].text.endsWith("…")).toBe(true);
	});
});

describe("router: slash subset (bypasses the busy guard)", () => {
	it("/stop aborts and confirms even while busy", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.status.busy = true;
		await router.handleEvent(dmEvent("/stop"));
		expect(bridge.aborted).toHaveLength(1);
		expect(adapter.sent.map((m) => m.text).some((t) => t.includes("Stopped."))).toBe(true);
		expect(bridge.calls).toEqual([]);
	});

	it("/new resets the session and confirms", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		await router.handleEvent(dmEvent("/new"));
		expect(bridge.resets).toHaveLength(1);
		expect(
			adapter.sent
				.map((m) => m.text)
				.some((t) => t.includes("Session reset — next message starts a fresh session.")),
		).toBe(true);
	});

	it("/new resets even while busy", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		bridge.status.busy = true;
		await router.handleEvent(dmEvent("/new"));
		expect(bridge.resets).toHaveLength(1);
		expect(
			adapter.sent
				.map((m) => m.text)
				.some((t) => t.includes("Session reset — next message starts a fresh session.")),
		).toBe(true);
		expect(adapter.sent.map((m) => m.text).some((t) => t.includes("busy"))).toBe(false);
		expect(bridge.calls).toEqual([]);
	});

	it("/status reports platform, state and queue depth", async () => {
		const { adapter, router } = makeDeps(makeConfig());
		await router.handleEvent(dmEvent("/status"));
		expect(adapter.sent).toHaveLength(1);
		expect(adapter.sent[0].text).toContain("telegram");
		expect(adapter.sent[0].text).toContain("idle");
		expect(adapter.sent[0].text).toContain("queue 0");
	});

	it("/whoami reports ids and the session key", async () => {
		const { adapter, router } = makeDeps(makeConfig());
		await router.handleEvent(dmEvent("/whoami"));
		expect(adapter.sent[0].text).toContain("userId: u1");
		expect(adapter.sent[0].text).toContain("chatId: chat1");
		expect(adapter.sent[0].text).toContain("key: agent:main:telegram:dm:chat1");
	});

	it("unknown slash commands in DMs are treated as normal text", async () => {
		const { bridge, router } = makeDeps(makeConfig());
		await router.handleEvent(dmEvent("/unknown do stuff"));
		expect(bridge.calls).toHaveLength(1);
		expect(bridge.calls[0].event.text).toBe("/unknown do stuff");
	});
});
