/**
 * ChatboxEditor — the lunR prompt box (absorbed from the former ashxj-tui
 * baked-in extension into core).
 *
 * A rounded prompt box that auto-expands as the typed message wraps to
 * multiple rows (the sides extend; height grows with content), with a
 * right-aligned chip on the box's BOTTOM border:
 *   model · provider · effort     (e.g. `glm-5.2 · Ollama Cloud · xhigh`)
 *
 * Extends CustomEditor to inherit the app keybindings (escape, ctrl+d, model
 * switching, extension shortcuts).
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { clampLines, displayWidth, padRight, safeColor, truncatePlain } from "../text-measure.ts";
import { theme } from "../theme/theme.ts";
import { CustomEditor } from "./custom-editor.ts";

const LUNR_PROMPT_GLYPH = "☾ › ";

/** Everything the editor needs from the running session, as live getters. */
export interface ChatboxEditorDeps {
	getModel(): Model<any> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getPromptSymbol(): boolean;
}

/** Trimmed view of an autocomplete list (the editor's private `autocompleteList`). */
interface AutocompleteListLike {
	render(width: number): string[];
}

// ---------------------------------------------------------------------------
// Provider display label
//
// `model.provider` is a ProviderId string (e.g. `"ollama-cloud"`), NOT the
// human label. Derived here (mirrors zentui's `formatProviderLabel`, with an
// explicit `ollama-cloud` entry).
// ---------------------------------------------------------------------------

function formatProviderLabel(provider: string | undefined): string {
	if (!provider) return "Unknown";
	const known: Record<string, string> = {
		anthropic: "Anthropic",
		gemini: "Google",
		google: "Google",
		ollama: "Ollama",
		"ollama-cloud": "Ollama Cloud",
		openai: "OpenAI",
		"openai-codex": "OpenAI",
		mistral: "Mistral",
	};
	return known[provider] ?? provider.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export class ChatboxEditor extends CustomEditor {
	private readonly deps: ChatboxEditorDeps;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, deps: ChatboxEditorDeps) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
		this.deps = deps;
		// `borderColor` is used internally by the base editor; route it through our
		// theme so any internal use stays consistent with the frame.
		this.borderColor = (s: string) => this.color("border", s);
	}

	private color(token: string, text: string): string {
		return safeColor(theme, token, text);
	}

	private buildChip(): string {
		const model = this.deps.getModel();
		const modelId = model?.id ?? "no-model";
		const providerLabel = formatProviderLabel(model?.provider);
		const effort = this.deps.getThinkingLevel();
		return `${modelId} · ${providerLabel} · ${effort}`;
	}

	override render(width: number): string[] {
		// Too narrow to draw a box — defer to the base editor, clamped.
		if (width <= 4) {
			return clampLines(super.render(width), width);
		}

		// Rails: `│ ` (left) + ` │` (right) => 4 columns of chrome.
		const promptSymbol = this.deps.getPromptSymbol();
		const glyphW = promptSymbol ? displayWidth(LUNR_PROMPT_GLYPH) : 0;
		const innerWidth = Math.max(1, width - 4 - glyphW);
		const base = super.render(innerWidth);

		// The base editor appends the autocomplete menu lines (if any) to the END
		// of its render output. Split them off so the body sits inside the box and
		// the autocomplete renders BELOW the bottom border (preserves slash
		// commands). Mirrors zentui's `renderPolishedFrame`.
		const showing = this.isShowingAutocomplete();
		const acList = (this as unknown as { autocompleteList?: AutocompleteListLike }).autocompleteList;
		let acCount = 0;
		if (showing && acList && typeof acList.render === "function") {
			try {
				acCount = acList.render(innerWidth).length;
			} catch {
				acCount = 0;
			}
		}

		// `super.render` returns [base top ─ border, ...wrapped text lines, base
		// bottom ─ border, ...autocomplete lines] — the base editor draws its OWN
		// straight borders and (when active) appends the autocomplete menu. Split the
		// autocomplete off the end, then STRIP the base's first/last lines (its own
		// borders) so we don't render them a second time inside our rounded frame.
		// Mirrors zentui's `editorFrame.slice(1, -1)` (renderPolishedFrame).
		let frame = base;
		let acLines: string[] = [];
		if (acCount > 0 && acCount < frame.length) {
			acLines = frame.slice(frame.length - acCount);
			frame = frame.slice(0, frame.length - acCount);
		}
		const inner = frame.length >= 2 ? frame.slice(1, frame.length - 1) : frame;
		const body = inner.length > 0 ? inner : [""];

		const border = (s: string): string => this.color("border", s);

		// Top border: ╭─…─╮
		const top = border("╭" + "─".repeat(width - 2) + "╮");

		// Body: │ <padded line> │ (auto-grows with the number of wrapped lines)
		// lunr: prefix the first body line with the dim `☾ › ` prompt glyph; a
		// same-width blank gutter keeps subsequent lines aligned with the border.
		const gutter = glyphW > 0 ? " ".repeat(glyphW) : "";
		const bodyLines = body.map((ln: string, i: number) => {
			const prefix = i === 0 && promptSymbol ? this.color("dim", LUNR_PROMPT_GLYPH) : gutter;
			return border("│ ") + prefix + padRight(ln, innerWidth) + border(" │");
		});

		// Bottom border with the right-aligned chip: ╰─…─ <chip> ─╯
		const bottom = this.renderBottomBorder(width);

		return [top, ...bodyLines, bottom, ...acLines];
	}

	private renderBottomBorder(width: number): string {
		const border = (s: string): string => this.color("border", s);
		let chip = this.buildChip();
		let chipW = displayWidth(chip);

		// Overhead with zero dashes: ╰ + " " + chip + " " + ╯  => 4 columns.
		const overhead = 4;
		if (chipW > width - overhead) {
			chip = truncatePlain(chip, Math.max(0, width - overhead));
			chipW = displayWidth(chip);
		}
		const dashTotal = Math.max(0, width - overhead - chipW);
		// Right-align the chip: a single trailing dash before the corner, the
		// rest lead (right-aligns the chip near the corner).
		const rightDashes = Math.min(dashTotal, 1);
		const leftDashes = dashTotal - rightDashes;

		const left = "╰" + "─".repeat(leftDashes) + " ";
		const right = " " + "─".repeat(rightDashes) + "╯";
		return border(left) + this.color("dim", chip) + border(right);
	}
}
