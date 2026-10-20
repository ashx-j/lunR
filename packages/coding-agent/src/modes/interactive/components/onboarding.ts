/**
 * First-run onboarding: the slim box InteractiveMode shows in place of the editor when no
 * provider credential is saved. Each choice hands off to the existing /login flow.
 */

import type { CredentialInfo } from "@earendil-works/pi-ai";
import { type Component, getKeybindings, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import type { AuthSelectorProvider } from "./oauth-selector.ts";

export type OnboardingChoice = "oauth" | "api_key" | "custom" | "skip";

export interface OnboardingOption {
	choice: OnboardingChoice;
	label: string;
	description: string;
}

/** Text wraps at this many columns even when the chat is wider; the borders follow the chat width. */
const MAX_TEXT_WIDTH = 80;
/** Below this many description columns, each description moves under its label. */
const MIN_DESCRIPTION_WIDTH = 24;
const PROVIDER_NAME_LIMIT = 4;

/**
 * Whether startup should show onboarding: no saved credential for any provider (the list
 * `lunr doctor` reports as Logins) and no usable model. A session can still have a model
 * without a saved login, from an environment key or a local provider, and then lunR works.
 */
export function shouldShowOnboarding(
	credentials: readonly CredentialInfo[],
	model: { provider: string } | undefined,
): boolean {
	return credentials.length === 0 && (!model || model.provider === "unknown");
}

/** "A, B, C, D and 5 more", or "A, B and C" when everything fits. */
function formatProviderNames(names: readonly string[]): string {
	const unique = [...new Set(names)];
	if (unique.length > PROVIDER_NAME_LIMIT) {
		return `${unique.slice(0, PROVIDER_NAME_LIMIT).join(", ")} and ${unique.length - PROVIDER_NAME_LIMIT} more`;
	}
	if (unique.length < 2) return unique.join("");
	return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

/**
 * Builds the onboarding choices from the /login provider list (`getLoginProviderOptions`), so the
 * provider names cannot go stale. Account and API-key rows are left out when no provider offers them.
 */
export function buildOnboardingOptions(
	providers: readonly Pick<AuthSelectorProvider, "name" | "authType">[],
): OnboardingOption[] {
	const namesFor = (authType: AuthSelectorProvider["authType"]) =>
		providers.filter((provider) => provider.authType === authType).map((provider) => provider.name);
	const subscriptions = namesFor("oauth");
	const apiKeys = namesFor("api_key");
	const options: OnboardingOption[] = [];
	if (subscriptions.length > 0) {
		options.push({
			choice: "oauth",
			label: "Sign in with an account",
			description: formatProviderNames(subscriptions),
		});
	}
	if (apiKeys.length > 0) {
		options.push({ choice: "api_key", label: "Sign in with an API key", description: formatProviderNames(apiKeys) });
	}
	options.push(
		{
			choice: "custom",
			label: "Connect a custom API endpoint",
			description: "Ollama, LM Studio or any OpenAI-compatible server",
		},
		{ choice: "skip", label: "Skip for now", description: "Open the chat without a model" },
	);
	return options;
}

/** The onboarding box. Enter reports the highlighted choice; Escape reports "skip". */
export class OnboardingComponent implements Component {
	private selectedIndex = 0;
	private readonly options: readonly OnboardingOption[];
	private readonly onSelect: (choice: OnboardingChoice) => void;

	constructor(options: readonly OnboardingOption[], onSelect: (choice: OnboardingChoice) => void) {
		this.options = options;
		this.onSelect = onSelect;
	}

	invalidate(): void {
		// Rendering reads only the selection index.
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelect(selected.choice);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onSelect("skip");
		}
	}

	render(width: number): string[] {
		// One column of padding on each side, like the other selectors.
		const textWidth = Math.max(1, Math.min(width, MAX_TEXT_WIDTH) - 2);
		const pad = (lines: string[]) => lines.map((line) => ` ${line}`);
		const wrap = (text: string) => pad(wrapTextWithAnsi(text, textWidth));
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		return [
			border,
			"",
			...wrap(theme.fg("accent", theme.bold("Welcome to lunR"))),
			"",
			...wrap(theme.fg("text", "lunR needs a model provider before it can do anything.")),
			...wrap(theme.fg("text", "Pick how you want to sign in. You can add more later with /login.")),
			"",
			...pad(this.renderOptions(textWidth)),
			"",
			...wrap(
				`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "skip")}`,
			),
			"",
			border,
		];
	}

	// Two columns (label, then description) when the description gets enough room, otherwise
	// each description on the lines under its label. Long descriptions wrap in their column.
	private renderOptions(width: number): string[] {
		const labelWidth = Math.max(...this.options.map((option) => visibleWidth(option.label)));
		const descriptionColumn = 2 + labelWidth + 2;
		const twoColumns = width - descriptionColumn >= MIN_DESCRIPTION_WIDTH;
		const descriptionIndent = twoColumns ? descriptionColumn : 4;
		const lines: string[] = [];
		this.options.forEach((option, index) => {
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const label = theme.fg(selected ? "accent" : "text", option.label);
			const description = wrapTextWithAnsi(option.description, Math.max(1, width - descriptionIndent)).map((line) =>
				theme.fg("muted", line),
			);
			const indent = " ".repeat(descriptionIndent);
			if (twoColumns) {
				const gap = " ".repeat(labelWidth - visibleWidth(option.label) + 2);
				lines.push(`${prefix}${label}${gap}${description[0] ?? ""}`);
				lines.push(...description.slice(1).map((line) => indent + line));
			} else {
				lines.push(...wrapTextWithAnsi(`${prefix}${label}`, width), ...description.map((line) => indent + line));
			}
		});
		return lines;
	}
}
