import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markSessionHandoff } from "../src/core/session-handoff.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { BridgeSession } from "../src/gateway/agent-bridge.ts";
import { isGatewayOwner } from "../src/gateway/authz.ts";
import { handleCallback, resetButtonRegistry } from "../src/gateway/buttons.ts";
import { defaultGatewayConfig, loadGatewayConfig, saveGatewayConfig } from "../src/gateway/config.ts";
import { bindConversation } from "../src/gateway/conversations.ts";
import { runGateway } from "../src/gateway/index.ts";
import { createProjectFolder, handleMobileCommand, resolveWithinRoots } from "../src/gateway/mobile-commands.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import {
	createGatewayUI,
	flushGatewayOutbox,
	invalidateGatewayDialogs,
	queueGatewayText,
	rememberGatewayRole,
	sendGatewayNotice,
	startGatewayPresenter,
	stopGatewayPresenter,
} from "../src/gateway/presenter.ts";
import { type BridgeLike, createRouter } from "../src/gateway/router.ts";
import { claimGateway, readGatewayStatus, startupSpec } from "../src/gateway/service.ts";
import { validateBotToken } from "../src/gateway/setup.ts";
import { putSession } from "../src/gateway/store.ts";
import type { ButtonSpec, PlatformAdapter, SessionSource } from "../src/gateway/types.ts";

let dir: string;
const source: SessionSource = { platform: "telegram", chatId: "1", userId: "1", chatType: "dm" };
const key = "telegram:dm:1";
const bridge: BridgeLike = {
	runTurn: async () => "",
	abort: async () => {},
	reset: async () => {},
	getStatus: () => ({ busy: false, queueDepth: 0 }),
	getSession: async () => null,
	switchSession: async () => {},
	undo: async () => ({ userText: "" }),
	redo: async () => {},
};
function adapter(): PlatformAdapter {
	return {
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
}
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gateway-remote-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	const cfg = defaultGatewayConfig();
	cfg.owners = { telegram: ["1"], discord: [] };
	cfg.projectRoots = [dir];
	saveGatewayConfig(cfg);
	bindConversation(key, source, { owner: "1", cwd: dir });
});
afterEach(() => {
	stopGatewayPresenter();
	resetButtonRegistry();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

describe("gateway startup", () => {
	const opts = {
		home: "/home/ash",
		agentDir: "/home/ash/.lunr/agent",
		node: "/opt/node",
		cli: "/opt/lunr/cli.js",
		username: "ash",
		uid: 1000,
	};
	it("uses user systemd units and enables lingering only for boot", () => {
		const login = startupSpec("linux", "login", opts);
		expect(login.content).toContain("Restart=on-failure");
		expect(login.content).toContain("gateway run");
		expect(login.install.flat()).not.toContain("enable-linger");
		expect(startupSpec("linux", "boot", opts).install[0]).toEqual(["loginctl", "enable-linger", "ash"]);
	});
	it("keeps macOS boot daemons under the user identity", () => {
		const boot = startupSpec("darwin", "boot", opts);
		expect(boot.path).toContain("/Library/LaunchDaemons/");
		expect(boot.content).toContain("<key>UserName</key><string>ash</string>");
		expect(boot.content).toContain("<key>SuccessfulExit</key><false/>");
		expect(startupSpec("darwin", "login", opts).path.replaceAll("\\", "/")).toContain(
			"/home/ash/Library/LaunchAgents/",
		);
	});
	it("uses OS credential prompts for Windows boot without storing passwords", () => {
		const boot = startupSpec("win32", "boot", opts);
		expect(boot.install.flat().join(" ")).toContain("Get-Credential");
		expect(boot.content).not.toContain("Password");
		expect(startupSpec("win32", "login", opts).install.flat().join(" ")).not.toContain("Get-Credential");
	});
	it("names each profile's service separately", () => {
		expect(startupSpec("linux", "login", opts).path).not.toBe(
			startupSpec("linux", "login", { ...opts, agentDir: "/another/profile" }).path,
		);
	});
	it("claims one daemon and releases only its own record", () => {
		const owner = claimGateway(() => {});
		try {
			expect(readGatewayStatus()?.pid).toBe(process.pid);
			expect(() => claimGateway(() => {})).toThrow("already running");
			owner.update({ telegram: "connected" });
			expect(readGatewayStatus()?.state).toBe("ready");
		} finally {
			owner.release();
		}
		expect(readGatewayStatus()).toBeUndefined();
	});
	it("accepts another stop request after failed shutdown and keeps readiness honest", async () => {
		vi.useFakeTimers();
		const onStop = vi.fn();
		const owner = claimGateway(onStop);
		try {
			owner.update({ telegram: "disconnected, retrying" }, "starting");
			expect(readGatewayStatus()?.state).toBe("starting");
			const { atomicJson, serviceDirectory } = await import("../src/gateway/service.ts");
			const instance = readGatewayStatus()!.instance;
			atomicJson(join(serviceDirectory(), "control.json"), { instance, action: "stop" });
			await vi.advanceTimersByTimeAsync(500);
			expect(onStop).toHaveBeenCalledTimes(1);
			owner.update({ telegram: "connected" }, "ready");
			await vi.advanceTimersByTimeAsync(500);
			expect(onStop).toHaveBeenCalledTimes(1);
			atomicJson(join(serviceDirectory(), "control.json"), { instance, action: "stop" });
			await vi.advanceTimersByTimeAsync(500);
			expect(onStop).toHaveBeenCalledTimes(2);
		} finally {
			owner.release();
		}
	});
	it("does not expose token URLs when validation fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("https://api.telegram.org/botSECRET/getMe");
			}),
		);
		await expect(validateBotToken("telegram", "SECRET")).rejects.toThrow("could not reach");
		await expect(validateBotToken("telegram", "SECRET")).rejects.not.toThrow("SECRET");
	});
});

describe("first chat readiness", () => {
	it("lets an owner use the approved default project for /start, /model and the first task", async () => {
		const cfg = loadGatewayConfig();
		cfg.defaultProject = dir;
		saveGatewayConfig(cfg);
		const owner: SessionSource = { ...source, chatId: "fresh", userId: "1" };
		const transport = adapter();
		const model = { id: "test", provider: "local", name: "test" };
		const session = {
			model,
			thinkingLevel: "off",
			modelRuntime: { refresh: vi.fn(), getAvailable: vi.fn(async () => [model]) },
			setModel: vi.fn(),
		} as unknown as BridgeSession;
		const active: BridgeLike = {
			...bridge,
			runTurn: vi.fn(async () => "hello back"),
			getSession: vi.fn(async (_key, create) => (create ? session : null)),
		};
		const router = createRouter({
			adapters: new Map([["telegram", transport]]),
			cfg,
			bridge: active,
			pairing: createPairingStore(),
			remoteControls: true,
		});
		const inbound = (text: string) => ({ text, messageId: "m", source: owner });
		await router.handleEvent(inbound("/start"));
		expect(vi.mocked(transport.send).mock.calls.at(-1)?.[1]).toContain("Ready");
		vi.mocked(session.modelRuntime.getAvailable).mockResolvedValueOnce([]);
		await router.handleEvent(inbound("/start"));
		expect(vi.mocked(transport.send).mock.calls.at(-1)?.[1]).toContain("/login on your computer");
		await router.handleEvent(inbound("/model"));
		expect(active.getSession).toHaveBeenCalledWith("agent:main:telegram:dm:fresh", true);
		await router.handleEvent(inbound("hi"));
		expect(active.runTurn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(transport.send).mock.calls.at(-1)?.[1]).toBe("hello back");
		const { conversationBinding } = await import("../src/gateway/conversations.ts");
		expect(conversationBinding("agent:main:telegram:dm:fresh")?.cwd).toBe(dir);
		await router.handleEvent(inbound("/new"));
		await router.handleEvent(inbound("hi again"));
		expect(active.runTurn).toHaveBeenCalledTimes(2);
	});
	it("does not promote paired non-owners or guess a root when several are approved", async () => {
		const cfg = loadGatewayConfig();
		cfg.projectRoots = [dir, join(dir, "another")];
		cfg.telegram.allowedUsers = ["2"];
		const transport = adapter();
		const active = { ...bridge, runTurn: vi.fn(async () => "unexpected") };
		const router = createRouter({
			adapters: new Map([["telegram", transport]]),
			cfg,
			bridge: active,
			pairing: createPairingStore(),
			remoteControls: true,
		});
		await router.handleEvent({ text: "/start", messageId: "m", source: { ...source, chatId: "2", userId: "2" } });
		expect(vi.mocked(transport.send).mock.calls.at(-1)?.[1]).toContain("paired but has no project");
		expect(active.runTurn).not.toHaveBeenCalled();
		await router.handleEvent({ text: "hi", messageId: "m", source: { ...source, chatId: "3" } });
		expect(vi.mocked(transport.send).mock.calls.at(-1)?.[1]).toContain("No default project selected");
		expect(active.runTurn).not.toHaveBeenCalled();
	});
});

describe("projects and owner access", () => {
	it("continues a stale phone binding without trying to reopen it before transfer", async () => {
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendMessage({ role: "user", content: "saved", timestamp: Date.now() });
		manager.flush();
		const file = manager.getSessionFile()!;
		markSessionHandoff(manager);
		putSession(key, { sessionId: manager.getSessionId(), sessionFile: file });
		manager.dispose();
		let switched = false;
		const replacement: BridgeLike = {
			...bridge,
			getSession: vi.fn(async () => {
				if (!switched) throw new Error("Cannot reopen the old writer before transfer");
				return {
					sessionManager: { getCwd: () => dir, getSessionName: () => "saved", getSessionId: () => undefined },
				} as unknown as BridgeSession;
			}),
			switchSession: vi.fn(async () => {
				switched = true;
			}),
		};
		const transport = adapter();
		await handleMobileCommand(
			{
				key,
				event: { source, text: "/continue", messageId: "m" },
				adapter: transport,
				bridge: replacement,
				cfg: loadGatewayConfig(),
			},
			"continue",
			"",
		);
		expect(vi.mocked(replacement.switchSession).mock.calls[0][0]).toBe(key);
		expect(vi.mocked(replacement.switchSession).mock.calls[0][1].toLowerCase()).toBe(file.toLowerCase());
		expect(replacement.getSession).toHaveBeenCalledTimes(1);
	});
	it("offers a cancellable choice when the current writer does not release within the initial timeout", async () => {
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendMessage({ role: "user", content: "saved", timestamp: Date.now() });
		manager.flush();
		markSessionHandoff(manager);
		const transport = adapter();
		startGatewayPresenter(new Map([["telegram", transport]]));
		const replacement = { ...bridge, switchSession: vi.fn(async () => {}) };
		try {
			const pending = handleMobileCommand(
				{
					key,
					event: { source, text: "/continue", messageId: "m" },
					adapter: transport,
					bridge: replacement,
					cfg: loadGatewayConfig(),
				},
				"continue",
				"",
			);
			await vi.waitFor(() => expect(transport.sendButtons).toHaveBeenCalled(), { timeout: 5_000 });
			const rows = vi.mocked(transport.sendButtons).mock.calls.at(-1)![2] as ButtonSpec[][];
			const cancel = rows.flat().find((button) => button.label === "Cancel");
			expect(cancel).toBeDefined();
			await handleCallback(
				{ id: "cancel", chatId: "1", messageId: "2", userId: "1", data: cancel!.data },
				{
					adapter: transport,
					adapters: new Map([["telegram", transport]]),
					cfg: loadGatewayConfig(),
					pairing: createPairingStore(),
					bridge: replacement,
				},
			);
			await pending;
			expect(replacement.switchSession).not.toHaveBeenCalled();
		} finally {
			manager.dispose();
		}
	});
	it("grants owner status only when local pairing explicitly requests --owner", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const ordinary = createPairingStore().issueCode("telegram", "2")!;
			expect(await runGateway(["pair", "approve", "telegram", ordinary])).toBe(0);
			expect(loadGatewayConfig().owners?.telegram).not.toContain("2");
			const ownerCode = createPairingStore().issueCode("telegram", "3")!;
			expect(await runGateway(["pair", "approve", "telegram", ownerCode, "--owner"])).toBe(0);
			expect(loadGatewayConfig().owners?.telegram).toContain("3");
		} finally {
			log.mockRestore();
		}
	});
	it("does not grant owner capabilities through a group or another user", () => {
		const cfg = defaultGatewayConfig();
		cfg.owners = { telegram: ["1"], discord: [] };
		expect(isGatewayOwner(source, cfg)).toBe(true);
		expect(isGatewayOwner({ ...source, chatType: "group" }, cfg)).toBe(false);
		expect(isGatewayOwner({ ...source, userId: "2", roleAuthorized: true }, cfg)).toBe(false);
	});
	it("creates a folder only beneath an approved root", () => {
		const root = join(dir, "projects");
		mkdirSync(root);
		expect(createProjectFolder(root, "new-project", [root])).toBe(join(root, "new-project"));
		expect(() => createProjectFolder(root, "../escape", [root])).toThrow();
		expect(() => createProjectFolder(root, "CON", [root])).toThrow();
		expect(() => resolveWithinRoots(dir, [root])).toThrow("outside");
	});
	it("rejects a directory symlink that escapes its approved root", () => {
		const root = join(dir, "root");
		const outside = join(dir, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		symlinkSync(outside, join(root, "escape"), "junction");
		expect(() => resolveWithinRoots(join(root, "escape"), [root])).toThrow("outside");
	});
});

describe("mobile UI delivery", () => {
	it("persists and retries failed notification delivery", async () => {
		vi.useFakeTimers();
		const transport = adapter();
		vi.mocked(transport.send).mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
		startGatewayPresenter(new Map([["telegram", transport]]));
		await sendGatewayNotice(key, "Background work finished.");
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(3001);
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toEqual([]);
		expect(transport.send).toHaveBeenCalledTimes(2);
	});
	it("keeps a permanent failure diagnostic without blocking a different destination", async () => {
		const failing = adapter();
		vi.mocked(failing.send).mockResolvedValue({ success: false, retryable: false, error: "bad recipient" });
		const healthy = { ...adapter(), platform: "discord" };
		const second: SessionSource = { platform: "discord", chatId: "other", userId: "2", chatType: "dm" };
		const cfg = loadGatewayConfig();
		cfg.discord.allowedUsers = ["2"];
		saveGatewayConfig(cfg);
		const otherKey = "discord:dm:2";
		bindConversation(otherKey, second);
		startGatewayPresenter(
			new Map([
				["telegram", failing],
				["discord", healthy],
			]),
		);
		await sendGatewayNotice(key, "bad");
		await queueGatewayText(otherKey, second, healthy, "good", { kind: "result", cfg });
		expect(healthy.send).toHaveBeenCalledWith("other", "good", { threadId: undefined, replyTo: undefined });
		const saved = JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"));
		expect(saved).toMatchObject([{ text: "bad", failed: true }]);
		await flushGatewayOutbox();
		expect(failing.send).toHaveBeenCalledTimes(1);
		vi.mocked(failing.send).mockResolvedValue({ success: true });
		await queueGatewayText(key, source, failing, "later result", { kind: "result", cfg });
		expect(failing.send).toHaveBeenCalledTimes(2);
	});

	it("stops retrying after five temporary failures and retains the batch for diagnosis", async () => {
		const transport = adapter();
		vi.mocked(transport.send).mockResolvedValue({ success: false, retryable: true, error: "offline" });
		startGatewayPresenter(new Map([["telegram", transport]]));
		await queueGatewayText(key, source, transport, "retry me", { kind: "result" });
		const now = vi.spyOn(Date, "now");
		try {
			for (let attempt = 1; attempt < 5; attempt++) {
				const [pending] = JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"));
				now.mockReturnValue(pending.nextAttempt + 1);
				await flushGatewayOutbox();
			}
			expect(transport.send).toHaveBeenCalledTimes(5);
			expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toMatchObject([
				{ failed: true, attempts: 5 },
			]);
			await flushGatewayOutbox();
			expect(transport.send).toHaveBeenCalledTimes(5);
		} finally {
			now.mockRestore();
		}
	});

	it("lets another destination deliver while one send is still pending", async () => {
		let release!: () => void;
		const stalled = adapter();
		vi.mocked(stalled.send).mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ success: false, retryable: false });
				}),
		);
		const second: SessionSource = { platform: "discord", chatId: "other", userId: "2", chatType: "dm" };
		const cfg = loadGatewayConfig();
		cfg.discord.allowedUsers = ["2"];
		saveGatewayConfig(cfg);
		const healthy = { ...adapter(), platform: "discord" };
		startGatewayPresenter(
			new Map([
				["telegram", stalled],
				["discord", healthy],
			]),
		);
		const pending = queueGatewayText(key, source, stalled, "blocked", { kind: "result", cfg });
		await queueGatewayText("discord:dm:2", second, healthy, "delivered", { kind: "result", cfg });
		expect(healthy.send).toHaveBeenCalledOnce();
		release();
		await pending;
	});

	it("drops a queued answer when destination authorization is revoked before retry", async () => {
		const transport = adapter();
		vi.mocked(transport.send).mockResolvedValueOnce({ success: false, retryable: true });
		startGatewayPresenter(new Map([["telegram", transport]]));
		await queueGatewayText(key, source, transport, "private answer", { kind: "result" });
		const cfg = loadGatewayConfig();
		cfg.owners.telegram = [];
		cfg.telegram.allowedUsers = [];
		saveGatewayConfig(cfg);
		await flushGatewayOutbox();
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toEqual([]);
	});

	it("suppresses a delayed old-session notice but keeps a completed result", async () => {
		const transport = adapter();
		startGatewayPresenter(new Map([["telegram", transport]]));
		const oldUi = createGatewayUI(key);
		invalidateGatewayDialogs(key);
		oldUi.notify("Old selection");
		await sendGatewayNotice(key, "Finished old task", "result");
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(vi.mocked(transport.send).mock.calls[0][1]).toBe("Finished old task");
	});

	it("does not replay a persisted role assertion after restart", async () => {
		const roleKey = "discord:group:role";
		const roleSource: SessionSource = {
			platform: "discord",
			chatId: "role",
			userId: "member",
			chatType: "group",
			roleAuthorized: true,
		};
		const transport = { ...adapter(), platform: "discord" };
		vi.mocked(transport.send).mockResolvedValueOnce({ success: false, retryable: true });
		startGatewayPresenter(new Map([["discord", transport]]));
		rememberGatewayRole(roleKey, roleSource);
		await queueGatewayText(roleKey, roleSource, transport, "role-only reply", { kind: "result" });
		expect(transport.send).toHaveBeenCalledTimes(1);
		stopGatewayPresenter();
		startGatewayPresenter(new Map([["discord", transport]]));
		await flushGatewayOutbox();
		expect(transport.send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toEqual([]);
	});

	it("migrates legacy outbox notices and drops stale new-session prompts", async () => {
		const transport = adapter();
		writeFileSync(
			join(dir, "gateway-outbox.json"),
			JSON.stringify([{ id: "legacy", key, epoch: 0, text: "Prior result" }]),
		);
		startGatewayPresenter(new Map([["telegram", transport]]));
		await flushGatewayOutbox();
		expect(transport.send).toHaveBeenCalledWith("1", "Prior result", { threadId: undefined, replyTo: undefined });
		vi.mocked(transport.send).mockResolvedValueOnce({ success: false, retryable: true });
		await sendGatewayNotice(key, "Stale question");
		invalidateGatewayDialogs(key);
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toEqual([]);
	});

	it("resolves a mobile confirmation from a button without a model turn", async () => {
		const transport = adapter();
		const cfg = defaultGatewayConfig();
		cfg.owners = { telegram: ["1"], discord: [] };
		startGatewayPresenter(new Map([["telegram", transport]]));
		const result = createGatewayUI(key).confirm("Plan", "Make this change?");
		await Promise.resolve();
		const rows = vi.mocked(transport.sendButtons).mock.calls[0][2] as ButtonSpec[][];
		await handleCallback(
			{ id: "click", chatId: "1", messageId: "2", userId: "1", data: rows[0][0].data },
			{
				adapter: transport,
				adapters: new Map([["telegram", transport]]),
				cfg,
				pairing: createPairingStore(),
				bridge,
			},
		);
		expect(await result).toBe(true);
	});
	it("invalidates pending decisions on session replacement", async () => {
		const transport = adapter();
		startGatewayPresenter(new Map([["telegram", transport]]));
		const result = createGatewayUI(key).confirm("Plan", "Make this change?");
		invalidateGatewayDialogs(key);
		expect(await result).toBe(false);
	});
});
