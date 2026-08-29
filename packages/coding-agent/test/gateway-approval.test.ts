import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSessionApprovals,
	gateToolCall,
	getPermissionMode,
	resetPermissions,
	setPermissionMode,
} from "../src/core/permissions.ts";
import type { TurnCallbacks } from "../src/gateway/agent-bridge.ts";
import { handleApprovalCallback, resetApprovalRegistry } from "../src/gateway/approval.ts";
import { defaultGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import { type BridgeLike, createRouter } from "../src/gateway/router.ts";
import type { ButtonSpec, CallbackEvent, MessageEvent, PlatformAdapter } from "../src/gateway/types.ts";

type GateResult = { block: true; reason: string } | undefined;

class FakeAdapter implements PlatformAdapter {
	readonly platform = "telegram";
	maxMessageLength = 4000;
	sent: Array<{ chatId: string; text: string; opts?: SendOptions; buttons?: ButtonSpec[][] }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string; buttons?: ButtonSpec[][] }> = [];
	callbackAnswers: Array<{ id: string; text?: string }> = [];
	private callbackHandler?: (event: CallbackEvent) => void | Promise<void>;

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
	async sendTyping(): Promise<void> {}
	onMessage(): void {}
	onCallback(handler: (event: CallbackEvent) => void | Promise<void>): void {
		this.callbackHandler = handler;
	}
	async answerCallback(id: string, text?: string): Promise<void> {
		this.callbackAnswers.push({ id, text });
	}
	simulateCallback(event: CallbackEvent): void {
		void this.callbackHandler?.(event);
	}
}

class FakeBridge implements BridgeLike {
	calls: Array<{ key: string; event: MessageEvent }> = [];
	aborted: string[] = [];
	resets: string[] = [];
	results: Array<string | Error> = [];
	status = { busy: false, queueDepth: 0 };
	onRunTurn?: () => void | Promise<void>;

	async runTurn(key: string, event: MessageEvent, _callbacks: TurnCallbacks): Promise<string> {
		this.calls.push({ key, event });
		await this.onRunTurn?.();
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

let tmpDir: string;

function makeConfig(mutate?: (cfg: GatewayConfig) => void): GatewayConfig {
	const cfg = defaultGatewayConfig();
	cfg.streaming.enabled = false;
	cfg.telegram.allowedUsers = ["u1"];
	mutate?.(cfg);
	return cfg;
}

function makeDeps(cfg: GatewayConfig) {
	const adapter = new FakeAdapter();
	const bridge = new FakeBridge();
	const pairing = createPairingStore({ dir: tmpDir });
	const router = createRouter({
		adapters: new Map([["telegram", adapter]]),
		cfg,
		pairing,
		bridge,
	});
	adapter.onCallback(async (event) => {
		await handleApprovalCallback(event, adapter);
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

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitFor timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function findButtonByLabel(adapter: FakeAdapter, label: string): ButtonSpec | undefined {
	for (const msg of adapter.sent) {
		const found = msg.buttons?.flat().find((b) => b.label === label);
		if (found) return found;
	}
	return undefined;
}

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lunr-gw-approval-"));
	resetPermissions("manual");
	clearSessionApprovals();
	resetApprovalRegistry();
});

afterEach(() => {
	resetPermissions("manual");
	resetApprovalRegistry();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("gateway manual-mode approvals", () => {
	it("prompts the originating chat for a mutating tool call and allows once", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		const gateResults: GateResult[] = [];
		bridge.onRunTurn = async () => {
			gateResults.push(await gateToolCall("bash", { command: "rm -rf /tmp" }, process.cwd()));
		};
		bridge.results = ["done"];

		const runPromise = router.handleEvent(dmEvent("go"));
		await waitFor(() => adapter.sent.some((m) => m.buttons));

		const once = findButtonByLabel(adapter, "✓ Approve once");
		expect(once).toBeDefined();
		expect(adapter.sent[0].text).toContain("Approve bash?");
		expect(adapter.sent[0].text).toContain("rm -rf /tmp");

		adapter.simulateCallback({
			id: "cb1",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u1",
			data: once!.data,
		});

		await runPromise;
		expect(gateResults).toHaveLength(1);
		expect(gateResults[0]).toBeUndefined();
		expect(adapter.edits[adapter.edits.length - 1].text).toBe("Approved (once).");
	});

	it("blocks the mutating tool when the user rejects", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		const gateResults: GateResult[] = [];
		bridge.onRunTurn = async () => {
			gateResults.push(await gateToolCall("write", { path: "/tmp/x.ts" }, process.cwd()));
		};
		bridge.results = ["done"];

		const runPromise = router.handleEvent(dmEvent("go"));
		await waitFor(() => adapter.sent.some((m) => m.buttons));

		const reject = findButtonByLabel(adapter, "✗ Reject");
		expect(reject).toBeDefined();

		adapter.simulateCallback({
			id: "cb2",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u1",
			data: reject!.data,
		});

		await runPromise;
		expect(gateResults).toHaveLength(1);
		expect(gateResults[0]).toEqual({ block: true, reason: "Rejected by user (permission mode: manual)." });
		expect(adapter.edits[adapter.edits.length - 1].text).toBe("Rejected.");
	});

	it("blocks mutating tools when there is no gateway approval context", async () => {
		makeDeps(makeConfig()); // registers the global gateway handler
		setPermissionMode("manual");
		clearSessionApprovals();
		const result = await gateToolCall("bash", { command: "ls" }, process.cwd());
		expect(result).toEqual({
			block: true,
			reason: "Mutating tool blocked in manual mode: no approval channel available.",
		});
	});

	it("ignores approval taps from a different user", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		let gateDone = false;
		bridge.onRunTurn = async () => {
			await gateToolCall("edit", { path: "/tmp/a.ts" }, process.cwd());
			gateDone = true;
		};
		bridge.results = ["done"];

		const runPromise = router.handleEvent(dmEvent("go"));
		await waitFor(() => adapter.sent.some((m) => m.buttons));

		const once = findButtonByLabel(adapter, "✓ Approve once")!;
		// Wrong user taps first — should be ignored.
		adapter.simulateCallback({
			id: "cb3",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u2",
			data: once.data,
		});

		expect(gateDone).toBe(false);
		expect(adapter.callbackAnswers.some((a) => a.text?.includes("Not your approval"))).toBe(true);

		// Correct user approves.
		adapter.simulateCallback({
			id: "cb4",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u1",
			data: once.data,
		});

		await runPromise;
		expect(gateDone).toBe(true);
	});

	it("defaults to manual permission mode for gateway sessions", () => {
		expect(getPermissionMode()).toBe("manual");
	});
});
