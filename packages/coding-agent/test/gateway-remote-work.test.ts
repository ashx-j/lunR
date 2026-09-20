import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGatewayOwner } from "../src/gateway/authz.ts";
import { handleCallback, resetButtonRegistry } from "../src/gateway/buttons.ts";
import { defaultGatewayConfig, saveGatewayConfig } from "../src/gateway/config.ts";
import { bindConversation } from "../src/gateway/conversations.ts";
import { createProjectFolder, resolveWithinRoots } from "../src/gateway/mobile-commands.ts";
import { createPairingStore } from "../src/gateway/pairing.ts";
import {
	createGatewayUI,
	invalidateGatewayDialogs,
	sendGatewayNotice,
	startGatewayPresenter,
	stopGatewayPresenter,
} from "../src/gateway/presenter.ts";
import type { BridgeLike } from "../src/gateway/router.ts";
import { claimGateway, readGatewayStatus, startupSpec } from "../src/gateway/service.ts";
import { validateBotToken } from "../src/gateway/setup.ts";
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

describe("projects and owner access", () => {
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
		await vi.advanceTimersByTimeAsync(3000);
		expect(JSON.parse(readFileSync(join(dir, "gateway-outbox.json"), "utf8"))).toEqual([]);
		expect(transport.send).toHaveBeenCalledTimes(2);
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
