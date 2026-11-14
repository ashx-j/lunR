import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	buildOnboardingOptions,
	OnboardingComponent,
	PERMISSION_MODE_OPTIONS,
	PERMISSION_MODE_STEP_TEXT,
	shouldAskPermissionMode,
	shouldShowOnboarding,
	WELCOME_TEXT,
} from "../src/modes/interactive/components/onboarding.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const placeholderModel = { provider: "unknown", id: "unknown" };
const savedLogin = [{ providerId: "anthropic", type: "oauth" as const }];

describe("shouldShowOnboarding", () => {
	it("shows onboarding without credentials", () => {
		expect(shouldShowOnboarding([], placeholderModel)).toBe(true);
	});

	it("skips onboarding when a credential exists but no model is selected", () => {
		expect(shouldShowOnboarding(savedLogin, placeholderModel)).toBe(false);
	});

	it("skips onboarding without credentials when a model is usable", () => {
		expect(shouldShowOnboarding([], { provider: "ollama-local", id: "llama3.2" })).toBe(false);
	});

	it("skips onboarding when a credential and a model exist", () => {
		expect(shouldShowOnboarding(savedLogin, { provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(false);
	});
});

describe("shouldAskPermissionMode", () => {
	it("does not ask before any login", () => {
		expect(shouldAskPermissionMode({ onboardingShown: true, loggedIn: false, savedDefault: undefined })).toBe(false);
	});

	it("asks after the first login on a launch that started without credentials", () => {
		expect(shouldAskPermissionMode({ onboardingShown: true, loggedIn: true, savedDefault: undefined })).toBe(true);
	});

	it("does not ask a profile that already saved a default mode", () => {
		expect(shouldAskPermissionMode({ onboardingShown: true, loggedIn: true, savedDefault: "yolo" })).toBe(false);
	});

	it("does not ask an upgraded profile that had a login before this launch", () => {
		expect(shouldAskPermissionMode({ onboardingShown: false, loggedIn: true, savedDefault: undefined })).toBe(false);
	});
});

describe("OnboardingComponent", () => {
	beforeAll(() => {
		initTheme("moon");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	// Part of the real /login list, in its name order, including the local servers lunr-local-providers adds.
	const providers = [
		...(
			[
				["anthropic", "Anthropic"],
				["github-copilot", "GitHub Copilot"],
				["lm-studio", "LM Studio (local)"],
				["ollama-local", "Ollama (local)"],
				["openai-codex", "OpenAI Codex"],
				["radius", "Radius"],
				["xai", "xAI"],
			] as const
		).map(([id, name]) => ({ id, name, authType: "oauth" as const })),
		...(
			[
				["amazon-bedrock", "Amazon Bedrock"],
				["ant-ling", "Ant Ling"],
				["anthropic", "Anthropic"],
				["azure-openai-responses", "Azure OpenAI"],
				["google", "Google"],
				["openai", "OpenAI"],
				["openrouter", "OpenRouter"],
				["xai", "xAI"],
			] as const
		).map(([id, name]) => ({ id, name, authType: "api_key" as const })),
	];

	it.each([80, 120])("renders the welcome box at %i columns", (width) => {
		const lines = new OnboardingComponent(buildOnboardingOptions(providers), WELCOME_TEXT, () => {}).render(width);
		const text = lines.map((line) => stripAnsi(line).trimEnd());

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text[0]).toBe("─".repeat(width));
		// Text wraps at 80 columns whatever the chat width.
		expect(text.slice(2, 14)).toEqual([
			" Welcome to lunR",
			"",
			" lunR needs a model provider before it can do anything.",
			" Pick how you want to sign in. You can add more later with /login.",
			"",
			" → Sign in with an account        Anthropic, OpenAI Codex, xAI and more",
			"   Sign in with an API key        Anthropic, OpenAI, xAI, Google and more",
			"   Connect a custom API endpoint  Any OpenAI-compatible server",
			"   Skip for now                   Open the chat without a model",
			"",
			" ↑↓ navigate  enter select  escape/ctrl+c skip",
			"",
		]);
	});

	it.each([80, 120])("renders the permission mode step at %i columns", (width) => {
		const lines = new OnboardingComponent(PERMISSION_MODE_OPTIONS, PERMISSION_MODE_STEP_TEXT, () => {}).render(width);
		const text = lines.map((line) => stripAnsi(line).trimEnd());

		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(text.slice(1, 14)).toEqual([
			"",
			" How should lunR handle changes?",
			"",
			" Sessions start in this permission mode.",
			" Shift+Tab switches it, and /settings changes the default.",
			"",
			" → YOLO  Runs every tool without asking",
			"   Auto  A review model checks risky actions first",
			"   Ask   Asks you before each change; reads run straight away",
			"   Read  Reads and searches only; blocks changes",
			"",
			" ↑↓ navigate  enter select  escape/ctrl+c keep yolo",
			"",
		]);
	});

	it("reports the picked mode, and Escape keeps the current default", () => {
		const onSelect = vi.fn();
		const step = new OnboardingComponent(PERMISSION_MODE_OPTIONS, PERMISSION_MODE_STEP_TEXT, onSelect);

		step.handleInput("j");
		step.handleInput("j");
		step.handleInput("\r");
		step.handleInput("\x1b");

		expect(onSelect.mock.calls).toEqual([["ask"], ["keep"]]);
	});

	it("reports the highlighted choice and treats Escape as skip", () => {
		const onSelect = vi.fn();
		const onboarding = new OnboardingComponent(buildOnboardingOptions(providers), WELCOME_TEXT, onSelect);

		onboarding.handleInput("j");
		onboarding.handleInput("\r");
		onboarding.handleInput("\x1b");

		expect(onSelect.mock.calls).toEqual([["api_key"], ["skip"]]);
	});
});
