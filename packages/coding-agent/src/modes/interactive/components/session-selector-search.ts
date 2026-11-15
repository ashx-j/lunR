import { type Context, createContext, Script } from "node:vm";
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = normalizeWhitespaceLower(text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

/** Time limit for one regex search over every session, so a backtracking pattern cannot freeze the TUI. */
const REGEX_SEARCH_TIMEOUT_MS = 25;

let regexSearch: { script: Script; context: Context } | undefined;

/**
 * Index of `regex`'s first match in each text, or undefined when the search hits the time limit.
 * vm's timeout interrupts V8 inside a backtracking match such as `(a+)+$`.
 */
function searchAll(regex: RegExp, texts: string[]): number[] | undefined {
	regexSearch ??= { script: new Script("texts.map((text) => text.search(regex))"), context: createContext({}) };
	const { script, context } = regexSearch;
	context.regex = regex;
	context.texts = texts;
	try {
		const result: unknown = script.runInContext(context, { timeout: REGEX_SEARCH_TIMEOUT_MS });
		return Array.isArray(result) ? result.map((index) => (typeof index === "number" ? index : -1)) : undefined;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
		)
			return undefined;
		throw error;
	} finally {
		context.regex = undefined;
		context.texts = undefined;
	}
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];
	const regexIndexes = parsed.regex ? searchAll(parsed.regex, nameFiltered.map(getSessionSearchText)) : undefined;
	if (parsed.regex && !regexIndexes) return [];
	const match = (session: SessionInfo, index: number): MatchResult => {
		if (!regexIndexes) return matchSession(session, parsed);
		const at = regexIndexes[index] ?? -1;
		return at < 0 ? { matches: false, score: 0 } : { matches: true, score: at * 0.1 };
	};

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const [index, s] of nameFiltered.entries()) {
			if (match(s, index).matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const [index, s] of nameFiltered.entries()) {
		const res = match(s, index);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
