/**
 * First-run onboarding: the slim box InteractiveMode shows in place of the editor when no
 * provider credential is saved. Each choice hands off to the existing /login flow.
 */

import type { CredentialInfo } from "@earendil-works/pi-ai";
import { type Component, getKeybindings, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { LOCAL_SERVERS } from "../../../builtin-extensions/lunr-local-providers/local-servers.ts";
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
/** Rows without a featured provider name this many providers instead. */
const PROVIDER_NAME_LIMIT = 4;
/** The providers both rows name, in this order; the rest only count toward "and more". */
const FEATURED_PROVIDER_IDS = ["anthropic", "openai-codex", "openai", "xai", "google"];
/** Keyless local servers (Ollama, LM Studio) sign in through the account flow but are not accounts. */
const LOCAL_PROVIDER_IDS = new Set(LOCAL_SERVERS.map((server) => server.providerId));

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

/**
 * "A, B, C and more" when only some names are shown, or "A, B and C" when all are. No count, so
 * the row stays one line and does not change as /login gains providers.
 */
function formatProviderNames(shown: readonly string[], total: number): string {
	if (shown.length < total) return `${shown.join(", ")} and more`;
	if (shown.length < 2) return shown.join("");
	return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * Builds the onboarding choices from the /login provider list (`getLoginProviderOptions`), so the
 * provider names cannot go stale. Both rows name only the featured providers and skip local servers.
 * Account and API-key rows are left out when no provider offers them.
 */
export function buildOnboardingOptions(
	providers: readonly Pick<AuthSelectorProvider, "id" | "name" | "authType">[],
): OnboardingOption[] {
	const featuredRank = (id: string) => {
		const rank = FEATURED_PROVIDER_IDS.indexOf(id);
		return rank === -1 ? FEATURED_PROVIDER_IDS.length : rank;
	};
	const describe = (authType: AuthSelectorProvider["authType"]) => {
		const matching = providers
			.filter((provider) => provider.authType === authType && !LOCAL_PROVIDER_IDS.has(provider.id))
			.sort((a, b) => featuredRank(a.id) - featuredRank(b.id));
		const names = [...new Set(matching.map((provider) => provider.name))];
		const featured = new Set(
			matching.filter((provider) => FEATURED_PROVIDER_IDS.includes(provider.id)).map((provider) => provider.name),
		);
		const shown = featured.size > 0 ? [...featured] : names.slice(0, PROVIDER_NAME_LIMIT);
		return names.length > 0 ? formatProviderNames(shown, names.length) : undefined;
	};
	const subscriptions = describe("oauth");
	const apiKeys = describe("api_key");
	const options: OnboardingOption[] = [];
	if (subscriptions) {
		options.push({ choice: "oauth", label: "Sign in with an account", description: subscriptions });
	}
	if (apiKeys) {
		options.push({ choice: "api_key", label: "Sign in with an API key", description: apiKeys });
	}
	options.push(
		{
			choice: "custom",
			label: "Connect a custom API endpoint",
			description: "Any OpenAI-compatible server",
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
