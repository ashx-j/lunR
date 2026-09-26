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

const threeTasks = {
	tasks: [
		{ task: "one", description: "One" },
		{ task: "two", description: "Two" },
		{ task: "three", description: "Three" },
	],
};

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "lunr-gw-approval-"));
	resetPermissions("yolo");
	clearSessionApprovals();
	resetApprovalRegistry();
});

afterEach(() => {
	resetPermissions("yolo");
	resetApprovalRegistry();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("gateway yolo-mode approvals", () => {
	it("prompts the originating chat for a large launch", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		const gateResults: GateResult[] = [];
		bridge.onRunTurn = async () => {
			gateResults.push(await gateToolCall("subagent", threeTasks, process.cwd()));
		};
		const runPromise = router.handleEvent(dmEvent("go"));
		await waitFor(() => adapter.sent.some((m) => m.buttons));
		expect(adapter.sent[0].text).toContain("Approve large subagent launch?");
		const once = findButtonByLabel(adapter, "✓ Approve once")!;
		adapter.simulateCallback({
			id: "cb1",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u1",
			data: once.data,
		});
		await runPromise;
		expect(gateResults).toEqual([undefined]);
	});

	it("ignores approvals from a different user and permits rejection", async () => {
		const { adapter, bridge, router } = makeDeps(makeConfig());
		let result: GateResult;
		bridge.onRunTurn = async () => {
			result = await gateToolCall("subagent", threeTasks, process.cwd());
		};
		const runPromise = router.handleEvent(dmEvent("go"));
		await waitFor(() => adapter.sent.some((m) => m.buttons));
		const reject = findButtonByLabel(adapter, "✗ Reject")!;
		adapter.simulateCallback({
			id: "cb2",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u2",
			data: reject.data,
		});
		expect(adapter.callbackAnswers.some((a) => a.text?.includes("Not your approval"))).toBe(true);
		adapter.simulateCallback({
			id: "cb3",
			chatId: "chat1",
			messageId: adapter.sent[0].messageId ?? "m1",
			userId: "u1",
			data: reject.data,
		});
		await runPromise;
		expect(result).toEqual({ block: true, reason: "Large subagent launch rejected by user." });
	});

	it("fails closed without an originating chat for large launches", async () => {
		makeDeps(makeConfig());
		setPermissionMode("yolo");
		expect(await gateToolCall("subagent", threeTasks, process.cwd())).toEqual({
			block: true,
			reason: "Approval channel unavailable.",
		});
	});

	it("defaults to yolo permission mode for gateway sessions", () => {
		expect(getPermissionMode()).toBe("yolo");
	});
});
