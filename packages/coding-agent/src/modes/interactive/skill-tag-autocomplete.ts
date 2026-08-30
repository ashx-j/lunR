import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { SkillTagCharacter } from "../../core/settings-manager.ts";

export interface SkillTagAutocompleteSkill {
	name: string;
	description?: string;
}

export interface WrapSkillTagAutocompleteOptions {
	character: SkillTagCharacter;
	skills: readonly SkillTagAutocompleteSkill[];
}

export function extractSkillTagPrefix(textBeforeCursor: string, character: SkillTagCharacter): string | null {
	if (textBeforeCursor.trimStart().startsWith("/")) {
		return null;
	}

	let tokenStart = 0;
	for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
		const ch = textBeforeCursor[i];
		if (ch === " " || ch === "\t") {
			tokenStart = i + 1;
			break;
		}
	}

	const token = textBeforeCursor.slice(tokenStart);
	if (!token.startsWith(character)) {
		return null;
	}
	if (character === "~" && (token.startsWith("~/") || token.startsWith("~\\"))) {
		return null;
	}
	return token;
}

export function wrapSkillTagAutocomplete(
	inner: AutocompleteProvider,
	options: WrapSkillTagAutocompleteOptions,
): AutocompleteProvider {
	const triggerCharacters = [...new Set([options.character, ...(inner.triggerCharacters ?? [])])];

	return {
		triggerCharacters,
		async getSuggestions(lines, cursorLine, cursorCol, suggestionOptions): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const prefix = extractSkillTagPrefix(textBeforeCursor, options.character);
			if (prefix === null) {
				return inner.getSuggestions(lines, cursorLine, cursorCol, suggestionOptions);
			}

			const query = prefix.slice(options.character.length);
			const filtered = fuzzyFilter([...options.skills], query, (skill) => skill.name);
			if (filtered.length === 0) {
				return null;
			}

			return {
				prefix,
				items: filtered.map((skill) => {
					const item: AutocompleteItem = {
						value: `${options.character}${skill.name}`,
						label: skill.name,
					};
					if (skill.description) {
						item.description = skill.description;
					}
					return item;
				}),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith(options.character)) {
				return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] || "";
			const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
			const afterCursor = currentLine.slice(cursorCol);
			const completed = `${item.value} `;
			const newLines = [...lines];
			newLines[cursorLine] = `${beforePrefix}${completed}${afterCursor}`;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + completed.length,
			};
		},
		shouldTriggerFileCompletion: inner.shouldTriggerFileCompletion?.bind(inner),
	};
}
