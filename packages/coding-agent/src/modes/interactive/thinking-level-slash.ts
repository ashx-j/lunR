import type { AutocompleteProvider } from "@earendil-works/pi-tui";

export const THINKING_LEVEL_SLASH_NAMES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function wrapThinkingLevelSlashCommands(
	inner: AutocompleteProvider,
	getLevels: () => readonly string[],
): AutocompleteProvider {
	return {
		triggerCharacters: inner.triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const result = await inner.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!result) return result;
			const textBefore = (lines[cursorLine] || "").slice(0, cursorCol);
			if (!textBefore.startsWith("/") || textBefore.includes(" ")) return result;
			const allowed = new Set(getLevels());
			const items = result.items.filter(
				(item) => !THINKING_LEVEL_SLASH_NAMES.has(item.value) || allowed.has(item.value),
			);
			if (items.length === 0) return null;
			return { ...result, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
	};
}
