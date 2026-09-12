import { afterEach, describe, expect, it, vi } from "vitest";
import computerUse from "../src/builtin-extensions/lunr-computer-use.ts";
import { COMPUTER_TOOLS, computerSettingsChanged } from "../src/core/computer-use/policy.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";

vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: { create: () => ({ getComputerUse: () => true, getComputerForeground: () => true }) },
}));
const setup = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("../src/core/computer-use/runtime.ts", () => ({ installRuntime: setup.install }));
const originalPlatform = process.platform;
const originalArch = process.arch;
afterEach(() => {
	vi.unstubAllEnvs();
	setup.install.mockReset();
	Object.defineProperty(process, "platform", { value: originalPlatform });
	Object.defineProperty(process, "arch", { value: originalArch });
});

function fixture(platform = "win32") {
	Object.defineProperty(process, "platform", { value: platform });
	Object.defineProperty(process, "arch", { value: platform === "darwin" ? "arm64" : "x64" });
	vi.stubEnv("PI_SUBAGENT_CHILD", "");
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	let active = ["read"];
	const pi = {
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			tools.set(tool.name, tool);
			active.push(tool.name);
		},
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	const ctx = { cwd: ".", model: { input: ["text", "image"] } } as ExtensionContext;
	computerUse(pi);
	return { active: () => active, handlers, tools, commands, ctx };
}

describe("computer extension lifecycle", () => {
	it("keeps setup local and gives the user the exact signed app path for OS grants", async () => {
		const f = fixture("darwin");
		const notify = vi.fn();
		const ctx = {
			...f.ctx,
			mode: "print",
			hasUI: false,
			ui: { notify },
			waitForIdle: vi.fn(),
		} as unknown as ExtensionCommandContext;
		const command = f.commands.get("computer")!;
		await command.handler("setup", ctx);
		expect(setup.install).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("local lunR terminal"), "warning");
		setup.install.mockResolvedValue({ app: "/owned/CuaDriver.app", command: "/owned/cua-driver" });
		await command.handler("setup", { ...ctx, mode: "tui", hasUI: true });
		expect(setup.install).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/owned/CuaDriver.app"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Setup has not captured"), "info");
		await f.handlers.get("session_shutdown")?.();
	});
	it("exposes discovery before the first request and disables active tools synchronously", async () => {
		const f = fixture();
		expect([...f.tools.keys()]).toEqual([...COMPUTER_TOOLS]);
		expect(f.tools.get("computer_load")?.description).toContain(
			"computer_end releases the workflow without a prompt",
		);
		expect(f.tools.get("computer_key")?.description).toContain("fresh accessibility element, screenshot coordinates");
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", "computer_load"]);
		await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", ...COMPUTER_TOOLS]);
		computerSettingsChanged({ enabled: false, foreground: true });
		expect(f.active()).toEqual(["read"]);
		computerSettingsChanged({ enabled: true, foreground: false });
		expect(f.active()).toEqual(["read", "computer_load"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("rejects an in-progress tool initialization when settings change", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		const pending = f.tools.get("computer_apps")?.execute("apps", {}, undefined, undefined, f.ctx);
		computerSettingsChanged({ enabled: false, foreground: false });
		await expect(pending).rejects.toThrow("session replaced");
		expect(f.active()).toEqual(["read"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("never reactivates discovery on an unsupported platform", async () => {
		const f = fixture("linux");
		await f.handlers.get("session_start")?.({}, f.ctx);
		computerSettingsChanged({ enabled: true, foreground: true });
		expect(f.active()).toEqual(["read"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("session replacement discards the loaded tool roster", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		await f.handlers.get("session_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", "computer_load"]);
		await f.handlers.get("session_shutdown")?.();
	});
});
