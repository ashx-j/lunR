import type { SelectList } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSecret } from "../src/cli/read-secret.ts";
import { showStartupInput } from "../src/cli/startup-ui.ts";
import { loadInstallFeatures, saveInstallFeatures } from "../src/core/install-features.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { defaultGatewayConfig, saveGatewayConfig } from "../src/gateway/config.ts";
import { configureStartup, startGatewayService } from "../src/gateway/service.ts";
import { selectSetupOption, setupGateway } from "../src/gateway/setup.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

vi.mock("../src/cli/read-secret.ts", () => ({ readSecret: vi.fn() }));
vi.mock("../src/cli/startup-ui.ts", () => ({
	createStartupTui: vi.fn(async () => ui),
	startStartupTui: vi.fn(() => {
		const answer = answers.shift();
		if (!list) throw new Error("No focused selection");
		if (answer === undefined) {
			list.handleInput("\x1b");
			return;
		}
		const first = list.getSelectedItem()?.value;
		while (list.getSelectedItem()?.label !== answer) {
			list.handleInput("\x1b[B");
			if (list.getSelectedItem()?.value === first) throw new Error(`Missing option: ${answer}`);
		}
		list.handleInput("\r");
	}),
	showStartupInput: vi.fn(),
}));
vi.mock("../src/core/model-runtime.ts", () => ({
	ModelRuntime: { create: vi.fn(async () => ({ getAvailable: async () => models })) },
}));
vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: { inMemory: vi.fn(() => settings), create: vi.fn(() => settings) },
}));
vi.mock("../src/core/install-features.ts", () => ({
	loadInstallFeatures: vi.fn(() => ({ features: {} })),
	saveInstallFeatures: vi.fn(),
}));
vi.mock("../src/gateway/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/gateway/config.ts")>()),
	loadGatewayConfig: vi.fn(() => cfg),
	saveGatewayConfig: vi.fn(),
}));
vi.mock("../src/gateway/service.ts", () => ({
	loadServiceSettings: vi.fn(() => ({ startup: "off" })),
	configureStartup: vi.fn(),
	startGatewayService: vi.fn(async () => "Started"),
}));

let cfg = defaultGatewayConfig();
let answers: Array<string | undefined>;
let list: SelectList | undefined;
const models = [
	{ provider: "fixture", id: "first" },
	{ provider: "fixture", id: "second" },
];
const settings = {
	getDefaultProvider: () => "fixture",
	getDefaultModel: () => "first",
	setDefaultModelAndProvider: vi.fn(),
	flush: vi.fn(),
};
const ui = {
	addChild: vi.fn(),
	setFocus: (component: SelectList) => {
		list = component;
	},
	clear: vi.fn(),
	requestRender: vi.fn(),
	stop: vi.fn(),
};
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

beforeEach(() => {
	vi.clearAllMocks();
	initTheme("moon");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ result: { id: 1, username: "fixture" } }))),
	);
	cfg = defaultGatewayConfig();
	cfg.telegram.token = "test-token";
	cfg.owners = { telegram: ["123"], discord: [] };
	answers = [
		"Telegram",
		"Keep the saved token",
		"Keep the saved owners",
		process.cwd(),
		"Off. Start manually",
		"fixture",
		"second",
		"Save",
		"Not now",
	];
	list = undefined;
	vi.mocked(showStartupInput).mockResolvedValue("");
	vi.mocked(readSecret).mockResolvedValue("replacement-test-token");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
	else delete process.stdin.isTTY;
	if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
	else delete process.stdout.isTTY;
});

describe("gateway setup menus", () => {
	it("configures saved credentials, workspace and model using arrows without text entry", async () => {
		await setupGateway();
		expect(answers).toEqual([]);
		expect(showStartupInput).not.toHaveBeenCalled();
		expect(readSecret).not.toHaveBeenCalled();
		expect(saveGatewayConfig).toHaveBeenCalledWith(expect.objectContaining({ defaultProject: expect.any(String) }));
		expect(settings.setDefaultModelAndProvider).toHaveBeenCalledWith("fixture", "second");
		expect(settings.flush).toHaveBeenCalledOnce();
		expect(configureStartup).toHaveBeenCalledWith("off");
		expect(startGatewayService).not.toHaveBeenCalled();
		expect(ui.stop).toHaveBeenCalledTimes(9);
	});

	it("keeps token entry private and permits explicit owner and custom folder entry", async () => {
		answers = [
			"Telegram",
			"Enter a different token",
			"Enter my user ID",
			"Enter another folder path",
			"When I sign in",
			"fixture",
			"first",
			"Save",
			"Start now",
		];
		vi.mocked(showStartupInput).mockResolvedValueOnce("456").mockResolvedValueOnce(process.cwd());
		await setupGateway();
		expect(readSecret).toHaveBeenCalledWith("telegram bot token");
		expect(cfg.owners?.telegram).toEqual(["123", "456"]);
		expect(configureStartup).toHaveBeenCalledWith("login");
		expect(startGatewayService).toHaveBeenCalledOnce();
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("replacement-test-token");
	});

	it("cancels with Escape before saving or changing service settings", async () => {
		answers[7] = undefined;
		await setupGateway();
		expect(saveGatewayConfig).not.toHaveBeenCalled();
		expect(settings.setDefaultModelAndProvider).not.toHaveBeenCalled();
		expect(saveInstallFeatures).not.toHaveBeenCalled();
		expect(configureStartup).not.toHaveBeenCalled();
		expect(startGatewayService).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith("Cancelled. Nothing saved.");
	});

	it("does not undo saved settings or start the service when cancelling the final prompt", async () => {
		answers[8] = undefined;
		await setupGateway();
		expect(saveGatewayConfig).toHaveBeenCalledOnce();
		expect(startGatewayService).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith("Settings saved. Start the gateway with lunr gateway start.");
	});

	it("offers later pairing without silently granting owner access", async () => {
		cfg.owners = { telegram: [], discord: [] };
		answers[2] = "Approve a pairing code later on this computer";
		await setupGateway();
		expect(cfg.owners.telegram).toEqual([]);
		expect(cfg.telegram.allowedUsers).toEqual([]);
		expect(showStartupInput).not.toHaveBeenCalled();
	});

	it("scrolls long model menus and cleans up the terminal after selection", async () => {
		answers = ["Model 25"];
		const options = Array.from({ length: 30 }, (_, value) => ({ label: `Model ${value}`, value }));
		await expect(selectSetupOption(SettingsManager.inMemory(), "Model", options, 20)).resolves.toBe(25);
		const rendered = list?.render(80) ?? [];
		expect(rendered.join("\n")).toContain("Model 25");
		expect(rendered.length).toBeLessThanOrEqual(9);
		expect(ui.clear).toHaveBeenCalledOnce();
		expect(ui.stop).toHaveBeenCalledOnce();
	});

	it("rejects noninteractive setup without reading credentials or configuring services", async () => {
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		await expect(setupGateway()).rejects.toThrow("Run lunr gateway setup in a terminal");
		expect(ModelRuntime.create).not.toHaveBeenCalled();
		expect(loadInstallFeatures).not.toHaveBeenCalled();
		expect(configureStartup).not.toHaveBeenCalled();
	});
});
