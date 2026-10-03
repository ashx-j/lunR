import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { atomicJson, startupSpec, teardownGatewayService } from "../src/gateway/service.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: vi.fn((await importOriginal<typeof import("node:os")>()).homedir),
	userInfo: vi.fn(() => ({ username: "fixture-user", uid: 1000, gid: 1000, shell: null, homedir: "/unused" })),
}));

let home: string;
let profile: string;
let previousAgentDir: string | undefined;
let platformDescriptor: PropertyDescriptor | undefined;
let alive: boolean;
const status = {
	version: 1,
	instance: "fixture-instance",
	pid: 987654,
	startedAt: "2026-10-03T00:00:00Z",
	updatedAt: "2026-10-03T00:00:00Z",
	state: "ready",
	platforms: {},
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "lunr-teardown-"));
	profile = join(home, "profile");
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = profile;
	platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
	vi.mocked(homedir).mockReturnValue(home);
	vi.mocked(spawnSync).mockReset();
	alive = false;
	vi.spyOn(process, "kill").mockImplementation(() => {
		if (alive) return true;
		throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" });
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(home, { recursive: true, force: true });
});

function startup(platform: NodeJS.Platform = "linux") {
	Object.defineProperty(process, "platform", { configurable: true, value: platform });
	const spec = startupSpec(platform, "login", {
		home,
		agentDir: profile,
		node: process.execPath,
		cli: resolve(process.argv[1]),
		username: userInfo().username,
		uid: 1000,
	});
	atomicJson(join(profile, "gateway-service/service.json"), { startup: "login" });
	mkdirSync(dirname(spec.path), { recursive: true });
	writeFileSync(spec.path, spec.content);
	return spec;
}

function running() {
	alive = true;
	atomicJson(join(profile, "gateway-service/status.json"), status);
	atomicJson(join(profile, "gateway-service/lock/owner.json"), status);
}

function mockCommands(spec: ReturnType<typeof startupSpec>, fail?: "disable" | "verify") {
	vi.mocked(spawnSync).mockImplementation((_command, args) => {
		const command = (args ?? []).join(" ");
		let stdout = "";
		let code = 0;
		if (command.includes("FragmentPath")) stdout = `DropInPaths=\nFragmentPath=${spec.path}\n`;
		if (command.includes("disable")) {
			alive = false;
			if (fail === "disable") code = 1;
		}
		if (command.includes("is-enabled")) {
			code = 1;
			stdout = "disabled\n";
		}
		if (command.includes("LoadState")) stdout = fail === "verify" ? "loaded\n" : "not-found\n";
		return { pid: 1, status: code, signal: null, output: [], stdout, stderr: "" };
	});
}

describe("installation-owned gateway teardown", () => {
	it("stops, disables and confirms removal without changing Linux lingering", async () => {
		const spec = startup();
		running();
		mockCommands(spec);
		await teardownGatewayService();
		expect(existsSync(spec.path)).toBe(false);
		expect(JSON.parse(readFileSync(join(profile, "gateway-service/service.json"), "utf8"))).toEqual({
			startup: "off",
		});
		expect(JSON.parse(readFileSync(join(profile, "gateway-service/control.json"), "utf8"))).toEqual({
			instance: status.instance,
			action: "stop",
		});
		const commands = vi.mocked(spawnSync).mock.calls.map(([command, args]) => [command, ...(args ?? [])].join(" "));
		expect(commands.some((command) => command.includes("disable --now"))).toBe(true);
		expect(commands.at(-1)).toContain("LoadState");
		expect(commands.some((command) => command.includes("loginctl"))).toBe(false);
		expect(process.kill).toHaveBeenCalledWith(status.pid, 0);
	});

	it("refuses mismatched PID or instance ownership without service operations", async () => {
		startup();
		running();
		atomicJson(join(profile, "gateway-service/lock/owner.json"), { ...status, instance: "another-owner" });
		await expect(teardownGatewayService()).rejects.toThrow("ownership disagree");
		expect(spawnSync).not.toHaveBeenCalled();
		expect(existsSync(join(profile, "gateway-service/control.json"))).toBe(false);
	});

	it("refuses systemd drop-ins and missing ownership values", async () => {
		const spec = startup();
		vi.mocked(spawnSync).mockReturnValueOnce({
			pid: 1,
			status: 0,
			signal: null,
			output: [],
			stdout: `FragmentPath=${spec.path}\nDropInPaths=/unrelated/override.conf\n`,
			stderr: "",
		});
		await expect(teardownGatewayService()).rejects.toThrow("ownership could not be verified");
		vi.mocked(spawnSync).mockReturnValueOnce({
			pid: 1,
			status: 0,
			signal: null,
			output: [],
			stdout: `FragmentPath=${spec.path}\n`,
			stderr: "",
		});
		await expect(teardownGatewayService()).rejects.toThrow("ownership could not be verified");
		expect(existsSync(spec.path)).toBe(true);
	});

	it("refuses a changed startup file without stopping any service", async () => {
		const spec = startup();
		running();
		writeFileSync(spec.path, "unrelated service");
		await expect(teardownGatewayService()).rejects.toThrow("does not match");
		expect(spawnSync).not.toHaveBeenCalled();
		expect(readFileSync(spec.path, "utf8")).toBe("unrelated service");
	});

	it("retains service settings and registration when disable fails", async () => {
		const spec = startup();
		mockCommands(spec, "disable");
		await expect(teardownGatewayService()).rejects.toThrow("failed");
		expect(existsSync(spec.path)).toBe(true);
		expect(JSON.parse(readFileSync(join(profile, "gateway-service/service.json"), "utf8"))).toEqual({
			startup: "login",
		});
	});

	it("does not claim unregister success when native verification says the unit remains loaded", async () => {
		const spec = startup();
		mockCommands(spec, "verify");
		await expect(teardownGatewayService()).rejects.toThrow("removal could not be confirmed");
		expect(existsSync(join(profile, "gateway-service/service.json"))).toBe(true);
	});

	it("waits for the owned process even if status disappears and retains control on timeout", async () => {
		vi.useFakeTimers();
		running();
		rmSync(join(profile, "gateway-service/status.json"));
		const failure = expect(teardownGatewayService()).rejects.toThrow("shutdown could not be confirmed");
		await vi.advanceTimersByTimeAsync(30_000);
		await failure;
		expect(existsSync(join(profile, "gateway-service/lock/owner.json"))).toBe(true);
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("checks Windows task action ownership before unregistering and verifies absence", async () => {
		const spec = startup("win32");
		vi.mocked(spawnSync).mockReturnValue({ pid: 1, status: 0, signal: null, output: [], stdout: "", stderr: "" });
		await teardownGatewayService();
		const commands = vi.mocked(spawnSync).mock.calls.map(([, args]) => args?.join(" ") ?? "");
		expect(commands[0]).toContain("Gateway task ownership mismatch");
		expect(commands[1]).toContain("Unregister-ScheduledTask");
		expect(commands[2]).toContain("Gateway task still registered");
		expect(existsSync(spec.path)).toBe(false);
	});

	it("confirms launchd absence and retains state on an ambiguous query failure", async () => {
		startup("darwin");
		vi.mocked(spawnSync).mockReturnValueOnce({ pid: 1, status: 0, signal: null, output: [], stdout: "", stderr: "" });
		vi.mocked(spawnSync).mockReturnValueOnce({
			pid: 1,
			status: 1,
			signal: null,
			output: [],
			stdout: "",
			stderr: "permission denied",
		});
		await expect(teardownGatewayService()).rejects.toThrow("launchd removal could not be confirmed");
		expect(existsSync(join(profile, "gateway-service/service.json"))).toBe(true);
	});
});
