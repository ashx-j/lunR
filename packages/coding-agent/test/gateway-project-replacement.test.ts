import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AgentBridge, type BridgeSession } from "../src/gateway/agent-bridge.ts";
import { handleCallback, resetButtonRegistry } from "../src/gateway/buttons.ts";
import { defaultGatewayConfig, loadGatewayConfig, saveGatewayConfig } from "../src/gateway/config.ts";
import { bindConversation, conversationBinding } from "../src/gateway/conversations.ts";
import { handleMobileCommand } from "../src/gateway/mobile-commands.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import { getSession, putSession } from "../src/gateway/store.ts";
import type { ButtonSpec, PlatformAdapter, SessionSource } from "../src/gateway/types.ts";

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

async function fixture(stage: "idle" | "shutdown") {
	const dir = mkdtempSync(join(tmpdir(), "lunr-project-replacement-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const source: SessionSource = { platform: "telegram", chatId: "1", userId: "1", chatType: "group" };
	const key = "agent:main:telegram:group:1";
	const picked = join(dir, "picked");
	const newer = join(dir, "newer");
	mkdirSync(picked);
	mkdirSync(newer);
	const cfg = defaultGatewayConfig();
	cfg.telegram.allowedUsers = ["1", "2"];
	cfg.projectRoots = [dir];
	saveGatewayConfig(cfg);
	bindConversation(key, source, { owner: "1", cwd: dir });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	const pause = async () => {
		if (!held) {
			held = true;
			entered();
			await barrier;
		}
	};
	const session = fakeSession();
	session.waitForIdle = stage === "idle" ? pause : async () => {};
	if (stage === "shutdown")
		session.extensionRunner!.emit = vi.fn(async () => {
			await pause();
		});
	const replacement = fakeSession();
	const factory = vi.fn().mockResolvedValueOnce(session).mockResolvedValue(replacement);
	const active = new AgentBridge({ sessionFactory: factory });
	await active.getSession(key, true);
	const transport: PlatformAdapter = {
		platform: "telegram",
		maxMessageLength: 4096,
		connect: async () => true,
		disconnect: async () => {},
		send: vi.fn(async () => ({ success: true, messageId: "1" })),
		sendButtons: vi.fn(async () => ({ success: true, messageId: "2" })),
		editMessage: vi.fn(async () => ({ success: true })),
		sendTyping: async () => {},
		onMessage: () => {},
		onCallback: () => {},
		answerCallback: vi.fn(async () => {}),
	};
	const deps = {
		adapter: transport,
		adapters: new Map([["telegram", transport]]),
		cfg,
		pairing: createPairingStore(),
		bridge: active,
	};
	const open = async (cwd: string) => {
		await handleMobileCommand(
			{
				key,
				event: { source, text: "/project", messageId: "m" },
				adapter: transport,
				bridge: active,
				cfg: loadGatewayConfig(),
			},
			"project",
			cwd,
		);
		const rows = vi.mocked(transport.sendButtons).mock.calls.at(-1)![2] as ButtonSpec[][];
		return rows.flat().find((button) => button.label === "Use this folder")!.data;
	};
	const choose = (data: string) =>
		handleCallback({ id: "choose", chatId: "1", messageId: "2", userId: "1", data }, deps);
	return {
		dir,
		source,
		key,
		picked,
		newer,
		started,
		release,
		session,
		replacement,
		factory,
		active,
		transport,
		open,
		choose,
		cleanup: async () => {
			release();
			await active.shutdown();
			resetButtonRegistry();
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

it.each(["idle", "shutdown"] as const)(
	"retains project replacement ownership through %s and rejects a newer overlapping selection",
	async (stage) => {
		const f = await fixture(stage);
		let pending: Promise<void> | undefined;
		try {
			pending = f.choose(await f.open(f.picked));
			await f.started;
			const newer = await f.open(f.newer);
			await f.choose(newer);
			expect(conversationBinding(f.key)?.cwd).toBe(f.dir);
			await expect(f.active.runTurn(f.key, { source: f.source, text: "task", messageId: "work" })).rejects.toThrow(
				"changing",
			);
			await expect(f.active.switchSession(f.key, "replacement.jsonl")).rejects.toThrow("progress");
			if (stage === "shutdown") await expect(f.active.getSession(f.key, true)).rejects.toThrow("changing");
			expect(f.factory).toHaveBeenCalledTimes(1);
			f.release();
			await pending;
			expect(conversationBinding(f.key)?.cwd).toBe(f.dir);
			expect(
				vi.mocked(f.transport.editMessage).mock.calls.some((call) => call[2].includes("Project selected")),
			).toBe(false);
			await f.choose(await f.open(f.newer));
			expect(conversationBinding(f.key)?.cwd).toBe(f.newer);
			expect(await f.active.getSession(f.key, true)).toBe(f.replacement);
			expect(f.replacement.dispose).not.toHaveBeenCalled();
		} finally {
			f.release();
			await pending;
			await f.cleanup();
		}
	},
);

it.each(
	(["idle", "shutdown"] as const).flatMap((stage) =>
		(["revoked", "roots", "requester", "stop"] as const).map((reason) => ({ stage, reason })),
	),
)("rechecks $reason after $stage", async ({ stage, reason }) => {
	const f = await fixture(stage);
	let pending: Promise<void> | undefined;
	try {
		pending = f.choose(await f.open(f.picked));
		await f.started;
		const cfg = loadGatewayConfig();
		if (reason === "revoked") {
			cfg.telegram.allowedUsers = [];
			saveGatewayConfig(cfg);
		} else if (reason === "roots") {
			cfg.projectRoots = [];
			saveGatewayConfig(cfg);
		} else if (reason === "requester")
			bindConversation(f.key, { ...f.source, userId: "2" }, { owner: "2", cwd: f.newer });
		else await f.active.abort(f.key);
		f.release();
		await pending;
		expect(conversationBinding(f.key)?.cwd).toBe(reason === "requester" ? f.newer : f.dir);
		expect(vi.mocked(f.transport.editMessage).mock.calls.some((call) => call[2].includes("Project selected"))).toBe(
			false,
		);
	} finally {
		f.release();
		await pending;
		await f.cleanup();
	}
});

it.each(["idle", "shutdown"] as const)(
	"permits a current project selection despite reset's own %s invalidation",
	async (stage) => {
		const f = await fixture(stage);
		let pending: Promise<void> | undefined;
		try {
			pending = f.choose(await f.open(f.picked));
			await f.started;
			f.release();
			await pending;
			expect(conversationBinding(f.key)?.cwd).toBe(f.picked);
			expect(f.session.dispose).toHaveBeenCalledTimes(1);
			expect(
				vi
					.mocked(f.transport.editMessage)
					.mock.calls.some((call) => call[2].includes(`Project selected: ${f.picked}`)),
			).toBe(true);
		} finally {
			f.release();
			await pending;
			await f.cleanup();
		}
	},
);

it("does not publish a replacement project if clearing the old stored session fails", async () => {
	const f = await fixture("shutdown");
	let pending: Promise<void> | undefined;
	try {
		const previous = putSession(f.key, { sessionId: "old", sessionFile: "old.jsonl" });
		mkdirSync(join(f.dir, `gateway-sessions.json.tmp-${process.pid}`));
		pending = f.choose(await f.open(f.picked));
		await f.started;
		f.release();
		await pending;
		expect(conversationBinding(f.key)?.cwd).toBe(f.dir);
		expect(getSession(f.key)).toEqual(previous);
		expect(vi.mocked(f.transport.editMessage).mock.calls.some((call) => call[2].includes("Project selected"))).toBe(
			false,
		);
	} finally {
		f.release();
		await pending;
		await f.cleanup();
	}
});
