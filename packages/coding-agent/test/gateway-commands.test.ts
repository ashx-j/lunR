import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { BridgeSession, BridgeSessionStatus } from "../src/gateway/agent-bridge.ts";
import {
	botCommandSpecs,
	CHAT_COMMANDS,
	type ChatCommandContext,
	formatHelpText,
	runChatCommand,
	sendCommandReply,
} from "../src/gateway/commands.ts";
import type { BridgeLike } from "../src/gateway/router.ts";
import type {
	ButtonSpec,
	CallbackEvent,
	MessageEvent,
	PlatformAdapter,
	SendOptions,
	SendResult,
	SessionSource,
} from "../src/gateway/types.ts";

class FakeAdapter implements PlatformAdapter {
	readonly platform = "telegram";
	maxMessageLength = 4000;
	sent: Array<{ chatId: string; text: string; opts?: SendOptions; buttons?: ButtonSpec[][] }> = [];
	edits: Array<{ chatId: string; messageId: string; text: string; buttons?: ButtonSpec[][] }> = [];
	callbackAnswers: Array<{ id: string; text?: string }> = [];
	private callbackHandler?: (event: CallbackEvent) => void;
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
	onCallback(handler: (event: CallbackEvent) => void): void {
		this.callbackHandler = handler;
	}
	async answerCallback(id: string, text?: string): Promise<void> {
		this.callbackAnswers.push({ id, text });
	}
	simulateCallback(event: CallbackEvent): void {
		this.callbackHandler?.(event);
	}
}

function makeSource(overrides: Partial<SessionSource> = {}): SessionSource {
	return {
		platform: "telegram",
		chatId: "chat1",
		chatType: "dm",
		userId: "u1",
		...overrides,
	};
}

function makeEvent(text: string, overrides: Partial<MessageEvent> = {}): MessageEvent {
	return {
		text,
		messageId: "msg1",
		source: makeSource(),
		...overrides,
	};
}

function fakeModel(id: string, provider = "ollama-cloud", reasoning = false) {
	return {
		id,
		provider,
		api: "openai" as const,
		contextWindow: 131_072,
		reasoning: reasoning ? ({ maxBudget: 1000 } as unknown as Record<string, unknown>) : undefined,
	};
}

function fakeTool(name: string): { name: string; description: string; parameters: unknown } {
	return { name, description: `${name} tool`, parameters: {} };
}

function createFakeSession(): BridgeSession {
	let thinking: import("@earendil-works/pi-agent-core").ThinkingLevel = "off";
	let model = fakeModel("deepseek-v4-flash");
	const entries: Array<{ id: string; type: string; message?: { role: string }; parentId?: string }> = [
		{ id: "root", type: "message", message: { role: "user" }, parentId: undefined },
		{ id: "assistant-1", type: "message", message: { role: "assistant" }, parentId: "root" },
		{ id: "user-2", type: "message", message: { role: "user" }, parentId: "assistant-1" },
	];
	const tools = new Map<string, ReturnType<typeof fakeTool>>([
		["read", fakeTool("read")],
		["bash", fakeTool("bash")],
	]);
	return {
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn().mockReturnValue(() => {}),
		state: { messages: [] },
		dispose: vi.fn(),
		isStreaming: false,
		isCompacting: false,
		get model() {
			return model as unknown as import("@earendil-works/pi-ai/compat").Model<any>;
		},
		set model(value) {
			model = value as unknown as ReturnType<typeof fakeModel>;
		},
		modelRuntime: {
			refresh: vi.fn().mockResolvedValue(undefined),
			getAvailable: vi
				.fn()
				.mockResolvedValue([
					fakeModel("deepseek-v4-flash"),
					fakeModel("qwen-2.5-72b"),
					fakeModel("claude-opus-4", "anthropic", true),
				]),
		} as unknown as import("../src/core/model-runtime.ts").ModelRuntime,
		get thinkingLevel() {
			return thinking;
		},
		messages: [],
		systemPrompt: "system prompt",
		sessionManager: {
			getSessionId: () => "session-id",
			getSessionFile: () => "/tmp/session.jsonl",
			getCwd: () => process.cwd(),
			getSessionName: () => "test-session",
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => "user-2",
		},
		getActiveToolNames: () => ["read", "bash"],
		getToolDefinition: (name: string) => tools.get(name),
		getAvailableThinkingLevels: () =>
			(model.reasoning
				? ["off", "low", "high"]
				: ["off"]) as import("@earendil-works/pi-agent-core").ThinkingLevel[],
		supportsThinking: () => !!model.reasoning,
		setThinkingLevel: (level) => {
			thinking = level;
		},
		setModel: vi.fn().mockImplementation((m) => {
			model = m;
			return Promise.resolve();
		}),
		compact: vi.fn().mockResolvedValue({ summary: "summary", firstKeptEntryId: "root", tokensBefore: 12340 }),
		navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
		getContextUsage: () => ({ tokens: 12340, contextWindow: 131_072, percent: 9.4 }),
		getSessionStats: () => ({
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-id",
			totalMessages: 14,
			userMessages: 2,
			assistantMessages: 4,
			toolCalls: 3,
			toolResults: 5,
			tokens: { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0, total: 12000 },
			cost: 0,
		}),
		setSessionName: vi.fn(),
	} as unknown as BridgeSession;
}

class FakeBridge implements BridgeLike {
	status: BridgeSessionStatus = { busy: false, queueDepth: 0 };
	session: BridgeSession | null = createFakeSession();
	resets: string[] = [];
	aborted: string[] = [];
	switched: Array<{ key: string; sessionFile: string }> = [];
	undoCalls: string[] = [];
	redoCalls: string[] = [];
	undoResult: { userText: string } = { userText: "hello world" };
	lastRunTurn?: { key: string; event: MessageEvent };

	async runTurn(key: string, event: MessageEvent): Promise<string> {
		this.lastRunTurn = { key, event };
		return "swarm result";
	}
	async abort(key: string): Promise<void> {
		this.aborted.push(key);
	}
	reset(key: string): void {
		this.resets.push(key);
	}
	getStatus(): BridgeSessionStatus {
		return { ...this.status };
	}
	async getSession(): Promise<BridgeSession | null> {
		return this.session;
	}
	async switchSession(key: string, sessionFile: string): Promise<void> {
		this.switched.push({ key, sessionFile });
	}
	async undo(key: string): Promise<{ userText: string }> {
		this.undoCalls.push(key);
		return this.undoResult;
	}
	async redo(key: string): Promise<void> {
		this.redoCalls.push(key);
	}
}

let adapter: FakeAdapter;
let bridge: FakeBridge;

function makeCtx(text: string, overrides: Partial<MessageEvent> = {}): ChatCommandContext {
	const event = makeEvent(text, overrides);
	const key = "agent:main:telegram:dm:chat1";
	const trimmed = event.text.trim();
	const firstToken = trimmed.split(/\s+/, 1)[0].toLowerCase();
	const args = trimmed.slice(firstToken.length).trim();
	return {
		event,
		key,
		adapter,
		bridge,
		args,
		reply: (message: string) => sendCommandReply(adapter, event, message),
	};
}

beforeEach(() => {
	adapter = new FakeAdapter();
	bridge = new FakeBridge();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function findCommand(name: string) {
	const cmd = CHAT_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
	if (!cmd) throw new Error(`command not found: ${name}`);
	return cmd;
}

describe("command registry", () => {
	it("/help generates a help message from the registry", async () => {
		const ctx = makeCtx("/help");
		const consumed = await runChatCommand(findCommand("help"), ctx);
		expect(consumed).toBe(true);
		expect(adapter.sent[0].text).toContain("/new");
		expect(adapter.sent[0].text).toContain("/model");
		expect(adapter.sent[0].text).toContain("/compact");
	});

	it("formatHelpText includes all commands", () => {
		const text = formatHelpText();
		expect(text).toContain("/swarm");
		expect(text).toContain("/thinking");
		expect(text).toContain("/effort");
		expect(text).toContain("/reasoning");
		expect(text).toContain("/undo");
	});

	it("botCommandSpecs covers every command, aliases skipped, Telegram-safe names", () => {
		const specs = botCommandSpecs();
		expect(specs.map((s) => s.name)).toEqual(CHAT_COMMANDS.map((c) => c.name));
		expect(specs.map((s) => s.name)).toContain("thinking");
		expect(specs.map((s) => s.name)).not.toContain("effort");
		expect(specs.map((s) => s.name)).not.toContain("reasoning");
		for (const spec of specs) {
			expect(spec.name).toMatch(/^[a-z0-9_]{1,32}$/);
			expect(spec.description.trim().length).toBeGreaterThan(0);
			expect(spec.description.length).toBeLessThanOrEqual(256);
		}
	});
});

describe("busy policy", () => {
	it("non-bypass commands refuse while busy", async () => {
		bridge.status.busy = true;
		const ctx = makeCtx("/model");
		const consumed = await runChatCommand(findCommand("model"), ctx);
		expect(consumed).toBe(true);
		expect(adapter.sent[0].text).toContain("busy");
	});

	it("bypass commands run while busy", async () => {
		bridge.status.busy = true;
		const ctx = makeCtx("/stop");
		const consumed = await runChatCommand(findCommand("stop"), ctx);
		expect(consumed).toBe(true);
		expect(bridge.aborted).toContain(ctx.key);
		expect(adapter.sent[0].text).toContain("Stopped");
	});
});

describe("session guard", () => {
	it("commands that need a session reply when there is none", async () => {
		bridge.session = null;
		const ctx = makeCtx("/context");
		const consumed = await runChatCommand(findCommand("context"), ctx);
		expect(consumed).toBe(true);
		expect(adapter.sent[0].text).toContain("No session yet");
	});
});

describe("/new and /reset", () => {
	it("resets the bridge session and confirms", async () => {
		const ctx = makeCtx("/new");
		const consumed = await runChatCommand(findCommand("new"), ctx);
		expect(consumed).toBe(true);
		expect(bridge.resets).toContain(ctx.key);
		expect(adapter.sent[0].text).toContain("Session reset");
	});

	it("/reset is an alias for /new", async () => {
		const ctx = makeCtx("/reset");
		const consumed = await runChatCommand(findCommand("new"), ctx);
		expect(consumed).toBe(true);
		expect(bridge.resets).toContain(ctx.key);
	});
});

describe("/undo and /redo", () => {
	it("/undo calls bridge.undo and reports the user text", async () => {
		const ctx = makeCtx("/undo");
		const consumed = await runChatCommand(findCommand("undo"), ctx);
		expect(consumed).toBe(true);
		expect(bridge.undoCalls).toContain(ctx.key);
		expect(adapter.sent[0].text).toContain('"hello world"');
		expect(adapter.sent[0].text).toContain("/redo to restore");
	});

	it("/redo calls bridge.redo", async () => {
		const ctx = makeCtx("/redo");
		const consumed = await runChatCommand(findCommand("redo"), ctx);
		expect(consumed).toBe(true);
		expect(bridge.redoCalls).toContain(ctx.key);
		expect(adapter.sent[0].text).toContain("Redone");
	});
});

describe("/model", () => {
	it("lists available models as a two-level picker", async () => {
		const ctx = makeCtx("/model");
		await runChatCommand(findCommand("model"), ctx);
		expect(adapter.sent[0].text).toContain("Pick a model provider");
		const buttons = adapter.sent[0].buttons;
		expect(buttons).toBeDefined();
		const labels = buttons?.flat().map((b) => b.label);
		expect(labels).toContain("anthropic (1)");
		expect(labels).toContain("✓ ollama-cloud (2)");
	});

	it("selects a model by number", async () => {
		const listCtx = makeCtx("/model");
		await runChatCommand(findCommand("model"), listCtx);
		adapter.sent.length = 0;

		const ctx = makeCtx("/model 3");
		await runChatCommand(findCommand("model"), ctx);
		expect(bridge.session?.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "qwen-2.5-72b", provider: "ollama-cloud" }),
		);
		expect(adapter.sent[0].text).toContain("Model → ollama-cloud/qwen-2.5-72b");
	});

	it("selects a model by exact provider/id", async () => {
		const ctx = makeCtx("/model ollama-cloud/qwen-2.5-72b");
		await runChatCommand(findCommand("model"), ctx);
		expect(bridge.session?.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "qwen-2.5-72b" }));
	});

	it("searches by substring and resolves a single match", async () => {
		const ctx = makeCtx("/model qwen");
		await runChatCommand(findCommand("model"), ctx);
		expect(bridge.session?.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "qwen-2.5-72b" }));
	});

	it("shows multiple substring matches", async () => {
		const ctx = makeCtx("/model ollama");
		await runChatCommand(findCommand("model"), ctx);
		expect(bridge.session?.setModel).not.toHaveBeenCalled();
		expect(adapter.sent[0].text).toContain("1)");
		expect(adapter.sent[0].text).toContain("2)");
	});

	it("reports no API key auth errors", async () => {
		bridge.session!.setModel = vi.fn().mockRejectedValue(new Error("No API key for anthropic/claude-opus-4"));
		const ctx = makeCtx("/model anthropic/claude-opus-4");
		await runChatCommand(findCommand("model"), ctx);
		expect(adapter.sent[0].text).toContain("No API key for anthropic");
	});
});

describe("/title", () => {
	it("sets and reads back the session name", async () => {
		const ctx = makeCtx("/title my session");
		await runChatCommand(findCommand("title"), ctx);
		expect(bridge.session?.setSessionName).toHaveBeenCalledWith("my session");
		expect(adapter.sent[0].text).toContain('Session titled "test-session"');
	});

	it("shows the current name when no args", async () => {
		const ctx = makeCtx("/title");
		await runChatCommand(findCommand("title"), ctx);
		expect(adapter.sent[0].text).toContain("Session title: test-session");
	});
});

describe("/context", () => {
	it("formats context usage and breakdown", async () => {
		const ctx = makeCtx("/context");
		await runChatCommand(findCommand("context"), ctx);
		expect(adapter.sent[0].text).toContain("Context:");
		expect(adapter.sent[0].text).toContain("12,340 / 131,072 tokens");
		expect(adapter.sent[0].text).toContain("Session: 14 messages · 2 turns");
		expect(adapter.sent[0].text).toContain("model ollama-cloud/deepseek-v4-flash");
	});
});

describe("/swarm", () => {
	it("rejects an empty task", async () => {
		const ctx = makeCtx("/swarm");
		const consumed = await runChatCommand(findCommand("swarm"), ctx);
		expect(consumed).toBe(true);
		expect(adapter.sent[0].text).toContain("Usage");
	});

	it("mutates the event text and returns passthrough for a normal turn", async () => {
		const ctx = makeCtx("/swarm research the moon");
		const consumed = await runChatCommand(findCommand("swarm"), ctx);
		expect(consumed).toBe(false);
		expect(ctx.event.text).toContain("[SWARM MODE]");
		expect(ctx.event.text).toContain("research the moon");
	});
});

describe("/compact", () => {
	it("reports tokens before and after", async () => {
		bridge.session!.compact = vi.fn().mockResolvedValue({
			summary: "summary",
			firstKeptEntryId: "root",
			tokensBefore: 12340,
			estimatedTokensAfter: 2100,
		});
		const ctx = makeCtx("/compact");
		await runChatCommand(findCommand("compact"), ctx);
		expect(adapter.sent[0].text).toContain("Compacted: 12,340 → ~2,100 tokens");
	});

	it("passes custom instructions", async () => {
		const ctx = makeCtx("/compact focus on APIs");
		await runChatCommand(findCommand("compact"), ctx);
		expect(bridge.session?.compact).toHaveBeenCalledWith("focus on APIs");
	});

	it("catches known compact errors", async () => {
		bridge.session!.compact = vi.fn().mockRejectedValue(new Error("Nothing to compact (session too small)"));
		const ctx = makeCtx("/compact");
		await runChatCommand(findCommand("compact"), ctx);
		expect(adapter.sent[0].text).toContain("Nothing to compact");
	});
});

describe("/thinking", () => {
	it("shows available thinking levels as inline buttons", async () => {
		bridge.session!.model = fakeModel(
			"claude-opus-4",
			"anthropic",
			true,
		) as unknown as import("@earendil-works/pi-ai/compat").Model<any>;
		const ctx = makeCtx("/thinking");
		await runChatCommand(findCommand("thinking"), ctx);
		expect(adapter.sent[0].text).toContain("Pick a thinking level");
		const labels = adapter.sent[0].buttons?.flat().map((b) => b.label);
		expect(labels).toContain("✓ off");
		expect(labels).toContain("low");
		expect(labels).toContain("high");
	});

	it("sets a valid level", async () => {
		bridge.session!.model = fakeModel(
			"claude-opus-4",
			"anthropic",
			true,
		) as unknown as import("@earendil-works/pi-ai/compat").Model<any>;
		const ctx = makeCtx("/thinking high");
		await runChatCommand(findCommand("thinking"), ctx);
		expect(bridge.session?.thinkingLevel).toBe("high");
		expect(adapter.sent[0].text).toContain("Thinking → high");
	});

	it.each(["effort", "reasoning"] as const)("sets a valid level via /%s alias", async (alias) => {
		bridge.session!.model = fakeModel(
			"claude-opus-4",
			"anthropic",
			true,
		) as unknown as import("@earendil-works/pi-ai/compat").Model<any>;
		const ctx = makeCtx(`/${alias} high`);
		await runChatCommand(findCommand(alias), ctx);
		expect(bridge.session?.thinkingLevel).toBe("high");
		expect(adapter.sent[0].text).toContain("Thinking → high");
	});

	it("rejects invalid levels", async () => {
		bridge.session!.model = fakeModel(
			"claude-opus-4",
			"anthropic",
			true,
		) as unknown as import("@earendil-works/pi-ai/compat").Model<any>;
		const ctx = makeCtx("/thinking maximum");
		await runChatCommand(findCommand("thinking"), ctx);
		expect(adapter.sent[0].text).toContain("Invalid level");
	});

	it("reports unsupported models", async () => {
		const ctx = makeCtx("/thinking");
		await runChatCommand(findCommand("thinking"), ctx);
		expect(adapter.sent[0].text).toContain("doesn't support thinking");
	});
});

describe("/sessions", () => {
	const fakeSessions = [
		{
			path: "/tmp/session.jsonl",
			id: "session-a",
			cwd: process.cwd(),
			name: "test-session",
			created: new Date(),
			modified: new Date(Date.now() - 60_000),
			messageCount: 5,
			firstMessage: "hello",
			allMessagesText: "hello",
		},
		{
			path: "/tmp/other.jsonl",
			id: "session-b",
			cwd: process.cwd(),
			created: new Date(),
			modified: new Date(Date.now() - 120_000),
			messageCount: 2,
			firstMessage: "other",
			allMessagesText: "other",
		},
	] as unknown as import("../src/core/session-manager.ts").SessionInfo[];

	beforeEach(() => {
		vi.spyOn(SessionManager, "list").mockResolvedValue(fakeSessions);
	});

	it("lists sessions as inline buttons", async () => {
		const ctx = makeCtx("/sessions");
		await runChatCommand(findCommand("sessions"), ctx);
		expect(adapter.sent[0].text).toContain("Pick a session");
		const labels = adapter.sent[0].buttons?.flat().map((b) => b.label);
		expect(labels).toContain("☾ test-session");
		expect(labels).toContain("other");
	});

	it("refuses while busy", async () => {
		bridge.status.busy = true;
		const ctx = makeCtx("/sessions");
		await runChatCommand(findCommand("sessions"), ctx);
		expect(adapter.sent[0].text).toContain("busy");
		expect(bridge.switched).toHaveLength(0);
	});

	it("switch by number calls bridge.switchSession", async () => {
		const listCtx = makeCtx("/sessions");
		await runChatCommand(findCommand("sessions"), listCtx);
		adapter.sent.length = 0;

		const ctx = makeCtx("/sessions 2");
		await runChatCommand(findCommand("sessions"), ctx);
		expect(bridge.switched).toEqual([{ key: ctx.key, sessionFile: "/tmp/other.jsonl" }]);
		expect(adapter.sent[0].text).toContain("Switched to");
	});

	it("switch by id-prefix calls bridge.switchSession", async () => {
		const ctx = makeCtx("/sessions /tmp/session");
		await runChatCommand(findCommand("sessions"), ctx);
		expect(bridge.switched).toEqual([{ key: ctx.key, sessionFile: "/tmp/session.jsonl" }]);
		expect(adapter.sent[0].text).toContain("Switched to");
	});
});
