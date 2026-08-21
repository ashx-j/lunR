import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * Built-in behavior.md presets.
 *
 * Selecting default / humanizer / concise replaces ~/.lunr/agent/behavior.md.
 * Custom leaves the file alone. lunr-behavior re-reads the file every turn, so
 * hand edits apply without a watcher. Fingerprint the body (header comments
 * stripped) to detect drift off a built-in template.
 */

export const BEHAVIOR_PRESET_BRIDGE_SYMBOL = Symbol.for("@lunr/behavior-preset");

export type BehaviorPreset = "default" | "humanizer" | "concise" | "custom";

export const BEHAVIOR_PRESETS: readonly BehaviorPreset[] = ["default", "humanizer", "concise", "custom"];

export const BEHAVIOR_HEADER =
	"<!-- lunR behavior rules — one rule per line. Edit freely or use the behavior tools. -->\n";

/** Empty on purpose. Default content is a later fill-in. */
export const DEFAULT_BEHAVIOR_PRESET = "";

export const HUMANIZER_BEHAVIOR_PRESET = `# Humanizer (every reply)

Write like a person. Keep real claims. Never invent facts, names, numbers, dates, quotes, citations, rankings, or sources. Missing detail: ask or simplify. Fiction exempt when inventing is the task.

Match user voice when known. Personality (opinions, mixed feelings, humor, I, asides, uneven rhythm) only for essays/opinions/personal prose. Technical, legal, reference, factual stay neutral. Never invent facts for voice. Apply on the reply itself (no rewrite pass).

1. Inflated legacy. Avoid: stands/serves as; is a testament/reminder; vital/significant/crucial/pivotal/key role/moment; underscores/highlights its importance/significance; reflects broader; symbolizing its ongoing/enduring/lasting; contributing to the; setting the stage for; marking/shaping the; represents/marks a shift; key turning point; evolving landscape; focal point; indelible mark; deeply rooted.
2. Status name-drops. Avoid: independent coverage; local/regional/national media outlets; written by a leading expert; active social media presence. Cite only with what was said and where.
3. Shallow -ing tack-ons. Avoid: highlighting/underscoring/emphasizing; ensuring; reflecting/symbolizing; contributing to; cultivating/fostering; encompassing; showcasing.
4. Sales tone. Avoid: boasts a; vibrant; rich (figurative); profound; enhancing its; showcasing; exemplifies; commitment to; natural beauty; nestled; in the heart of; groundbreaking (figurative); renowned; breathtaking; must-visit; stunning.
5. Vague authorities. Avoid: Industry reports; Observers have cited; Experts argue; Some critics argue; several sources/publications (unnamed). Real source or drop claim. Never invent one.
6. Stock challenges/outlook. Avoid: Despite its... faces several challenges; Despite these challenges; Challenges and Legacy; Future Outlook.
7. Stock AI words (esp. clustered): Actually; additionally; align with; crucial; delve; emphasizing; enduring; enhance; fostering; garner; gate/gated/gating (figurative only; keep technical gate); highlight (verb); interplay; intricate/intricacies; key (adj); landscape (abstract); pivotal; quietly; showcase; tapestry (abstract); testament; underscore (verb); valuable; vibrant. Also: at the end of the day; when it comes to; in a world where; moving forward; circle back; deep dive; game-changer; double down; take a step back; on the same page; make no mistake; it turns out; let me be clear; navigate (for challenges); lean into; unpack (before analysis); straightforward (filler praise).
8. Prefer is/are/has. Avoid: serves as/stands as/marks/represents [a]; boasts/features/offers [a].
9. No not-X-but-Y or clipped negatives (Not only...but; It's not just X, it's Y; "no guessing"). Full clause.
10. No forced groups of three for a complete-sounding list.
11. No synonym cycling of one subject. No machine-repeated openings. One clear name. Deliberate rhythm OK.
12. No false from-X-to-Y when ends are not a real scale.
13. Prefer active voice with a clear subject.
14. No em/en dash characters, spaced dash pairs, or double-hyphen used as a dash, unless the user uses them. Use period, comma, colon, or parentheses.
15. No decorative bold on ordinary phrases.
16. No bold-label lists (\`- **Label:** text\`). Normal bullets or prose.
17. Headings in sentence case, not Title Case.
18. No decorative emojis on headings or bullets.
19. Straight quotes only, not curly quotes.
20. No chatbot leftovers: I hope this helps; Of course!; Certainly!; You're absolutely right!; Would you like...; Want me to...?; Should I continue?; let me know; here is a...
21. No cutoff padding or guessed biography: as of [date]; Up to my last training update; While specific details are limited/scarce; based on available information; not publicly available; maintains a low profile; keeps personal details private; prefers to stay out of the spotlight; likely [grew up/studied/began]; it is believed that. State unknown or omit. Never present a guess as fact.
22. No sycophantic openers (Great question!; excellent point; absolutely right).
23. Cut filler: In order to → To; Due to the fact that → Because; At this point in time → Now; In the event that → If; has the ability to → can; It is important to note that → (delete).
24. One needed qualifier max. Avoid stacks: to be fair; it's also possible; could potentially; might arguably; in some cases it may; this is an inference.
25. No generic positive endings (future looks bright; exciting times; journey toward excellence; step in the right direction). End on last concrete fact.
26. Hyphen pairs: keep before a noun when needed (\`high-quality report\`); drop after (\`report is high quality\`). Watch: third-party; cross-functional; client-facing; data-driven; decision-making; well-known; high-quality; real-time; long-term; end-to-end.
27. No deeper-truth framing: The real question is; at its core; in reality; what really matters; fundamentally; the deeper issue; the heart of the matter.
28. Do not announce the next point: Let's dive in/explore/break this down; here's what you need to know; now let's look at; without further ado; heads up; quick note; before I forget.
29. Do not restate a heading in the first sentence under it.
30. Describe current behavior. Prior versions only in changelogs/release notes/migration guides.
31. No forced punchlines or stacks of dramatic fragments. One short emphatic line OK.
32. No formulaic sayings: X is the Y of Z; X becomes a trap; X is not a tool but a mirror; the language/currency/architecture of.
33. No fake-candid hooks: Honestly?; Look; Here's the thing; The thing is; Let's be honest; Real talk.
34. Do not answer unraised objections: This isn't (mainly) about; I'm not saying/arguing; To be clear; Don't get me wrong; This is not to say; You could argue... but; Some might say... but. Direct claims OK.
35. Do not reject fake alternatives: A tempting option/approach would be; One might be tempted to; An obvious approach would be; You might think... but; It would be easy to just; Some would suggest. Keep real options a reader might choose.

Do not over-flag alone: polish; mixed register; dry prose without stock tells; formal words outside #7; salutations/sign-offs; one however/additionally; curly quotes alone; one dash alone; one short emphatic sentence; deliberate repeated openings; honestly/look mid-sentence; useful scope/legal/safety limits; real alternatives; unsourced web claims; clean formatting; watched phrases inside quotes, titles, names, or examples under discussion. Several patterns together beat one.

Keep: specific odd details; mixed feelings; era slang; deliberate first person; short/long mix; genuine asides or self-corrections.`;

export const CONCISE_BEHAVIOR_PRESET = `# Concise (every reply)

Be extremely concise. Sacrifice grammar for concision.

Plans are not novels. Terminals read bottom-up. Scanning beats reading. Fewer tokens = faster and cheaper.

## Brevity swaps
| Instead of | Write |
|---|---|
| The user will be able to... | User can... |
| This component is responsible for... | Handles... |
| In order to achieve this, we need to... | Requires: |
| It should be noted that... | (delete) |

Prefer: fragments over full sentences; tables over paragraphs; bullets over prose; diagrams over descriptions.

## Output order (always)
1. Brief overview (2-3 sentences max)
2. Main content (tables, bullets, diagrams)
3. Unresolved questions (if any)
4. Numbered action steps (ALWAYS LAST)

Unresolved questions go before action steps as short bullets. Catch ambiguity before it becomes a bug.

## Action steps (last visible block)
End every non-trivial reply with concrete numbered next steps. Most important = most visible at the bottom.

\`\`\`
## Next steps
1. ...
2. ...
\`\`\`

Trivial yes/no or single-fact answers may skip the scaffold. Any plan, fix, design, or multi-step answer must end on numbered steps.

## Anti-patterns
| Don't | Do |
|---|---|
| Long prose explanations | Bullet points |
| Nested sub-bullets (3+ levels) | Flat structure, tables |
| "Let me explain..." | Just explain |
| Repeating context | Reference by ID/name |
| Hedging language | Direct statements |

## Shape
Bad: The authentication system will need to handle user login. In order to accomplish this, we will need to implement a JWT-based mechanism that allows users to securely log in.

Good:
Auth: JWT login

| Piece | Detail |
|---|---|
| Endpoint | POST /auth/login |
| Token | JWT, 24h |
| Guard | verify on protected routes |

## Unresolved questions
- OAuth provider? (Google, GitHub, both)
- Session duration?

## Next steps
1. Add auth module at src/auth/
2. Add JWT dependency
3. Implement login endpoint
4. Add tests`;

export function isBehaviorPreset(value: unknown): value is BehaviorPreset {
	return value === "default" || value === "humanizer" || value === "concise" || value === "custom";
}

export function isBuiltinBehaviorPreset(preset: BehaviorPreset): boolean {
	return preset === "default" || preset === "humanizer" || preset === "concise";
}

export function behaviorFilePath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "behavior.md");
}

export function normalizeBehaviorBody(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter((line) => !line.startsWith("<!--"))
		.join("\n")
		.trim();
}

export function builtinBehaviorBody(preset: Exclude<BehaviorPreset, "custom">): string {
	if (preset === "humanizer") return HUMANIZER_BEHAVIOR_PRESET;
	if (preset === "concise") return CONCISE_BEHAVIOR_PRESET;
	return DEFAULT_BEHAVIOR_PRESET;
}

export function wrapBehaviorFile(body: string): string {
	const trimmed = body.replace(/\r\n/g, "\n").trim();
	if (!trimmed) return BEHAVIOR_HEADER;
	return `${BEHAVIOR_HEADER}${trimmed}\n`;
}

export function detectBehaviorPreset(fileText: string): BehaviorPreset {
	const body = normalizeBehaviorBody(fileText);
	if (body === normalizeBehaviorBody(HUMANIZER_BEHAVIOR_PRESET)) return "humanizer";
	if (body === normalizeBehaviorBody(CONCISE_BEHAVIOR_PRESET)) return "concise";
	if (body === normalizeBehaviorBody(DEFAULT_BEHAVIOR_PRESET)) return "default";
	return "custom";
}

export function readBehaviorFile(agentDir?: string): string {
	const file = behaviorFilePath(agentDir);
	if (!existsSync(file)) return "";
	return readFileSync(file, "utf-8");
}

export function writeBehaviorFile(body: string, agentDir?: string): void {
	const file = behaviorFilePath(agentDir);
	const dir = agentDir ?? getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(file, wrapBehaviorFile(body), "utf-8");
}

export function writeBehaviorPreset(preset: Exclude<BehaviorPreset, "custom">, agentDir?: string): void {
	writeBehaviorFile(builtinBehaviorBody(preset), agentDir);
}

export type ApplyBehaviorPresetResult = { ok: true; preset: BehaviorPreset } | { ok: false; reason: "needs-overwrite" };

/**
 * Persist a preset and, for built-ins, replace behavior.md.
 * Custom never writes. Switching onto a built-in while the file is custom
 * requires `{ overwrite: true }` so the settings UI can confirm first.
 */
export function applyBehaviorPreset(
	settingsManager: SettingsManager,
	preset: BehaviorPreset,
	agentDir?: string,
	options: { overwrite?: boolean } = {},
): ApplyBehaviorPresetResult {
	if (preset === "custom") {
		settingsManager.setBehaviorPreset("custom");
		return { ok: true, preset: "custom" };
	}
	const fingerprint = detectBehaviorPreset(readBehaviorFile(agentDir));
	if (fingerprint === "custom" && !options.overwrite) {
		return { ok: false, reason: "needs-overwrite" };
	}
	writeBehaviorPreset(preset, agentDir);
	settingsManager.setBehaviorPreset(preset);
	return { ok: true, preset };
}

/**
 * Align the stored preset with the file.
 * Custom stored always wins (file is the source of truth).
 * A custom file while a built-in is stored flips the setting to custom.
 * A missing/empty file while a non-default built-in is stored restores that template.
 * A different built-in already on disk is adopted (file wins).
 */
export function reconcileBehaviorPreset(settingsManager: SettingsManager, agentDir?: string): BehaviorPreset {
	const stored = settingsManager.getBehaviorPreset();
	const fingerprint = detectBehaviorPreset(readBehaviorFile(agentDir));
	if (stored === "custom") return "custom";
	if (fingerprint === stored) return stored;
	if (fingerprint === "custom") {
		settingsManager.setBehaviorPreset("custom");
		return "custom";
	}
	if (fingerprint === "default" && stored !== "default") {
		writeBehaviorPreset(stored, agentDir);
		return stored;
	}
	settingsManager.setBehaviorPreset(fingerprint);
	return fingerprint;
}

export interface BehaviorPresetBridge {
	getPreset(): BehaviorPreset;
	setPreset(preset: BehaviorPreset): void;
	isCapExempt(): boolean;
	/** Fingerprint the current file text; persist custom when a built-in selection drifted. */
	syncFromFile(fileText: string): BehaviorPreset;
}

let activeSettingsManager: SettingsManager | undefined;

const bridge: BehaviorPresetBridge = {
	getPreset(): BehaviorPreset {
		return activeSettingsManager?.getBehaviorPreset() ?? "default";
	},
	setPreset(preset: BehaviorPreset): void {
		activeSettingsManager?.setBehaviorPreset(preset);
	},
	isCapExempt(): boolean {
		const preset = activeSettingsManager?.getBehaviorPreset() ?? "default";
		return isBuiltinBehaviorPreset(preset);
	},
	syncFromFile(fileText: string): BehaviorPreset {
		const fingerprint = detectBehaviorPreset(fileText);
		const stored = activeSettingsManager?.getBehaviorPreset() ?? "default";
		// Per-turn: only flip a built-in to custom when the file drifted. Restoring a
		// missing template or adopting another built-in is reconcileBehaviorPreset.
		if (stored !== "custom" && fingerprint === "custom") {
			activeSettingsManager?.setBehaviorPreset("custom");
			return "custom";
		}
		return stored;
	},
};

export function registerBehaviorPresetBridge(settingsManager: SettingsManager): void {
	activeSettingsManager = settingsManager;
	(globalThis as Record<symbol, unknown>)[BEHAVIOR_PRESET_BRIDGE_SYMBOL] = bridge;
}

export function getBehaviorPresetBridge(): BehaviorPresetBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[BEHAVIOR_PRESET_BRIDGE_SYMBOL] as BehaviorPresetBridge | undefined;
}
