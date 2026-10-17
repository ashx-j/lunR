/**
 * Context windows of the models lunR's pinned Claude Code can route. 1M models use the explicit `[1m]`
 * route suffix so Claude Code always asks for the 1M window. Opus 5 stays on its standard window: Claude
 * Code bills its 1M variant from usage credits for every subscriber instead of from the plan.
 */
const ROUTE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	"claude-sonnet-5": 1_000_000,
	"claude-haiku-4-5-20251001": 200_000,
	"claude-opus-5": 200_000,
	"claude-opus-4-8": 1_000_000,
	"claude-fable-5-1": 1_000_000,
};
const ROUTE_ALIASES: Readonly<Record<string, string>> = {
	sonnet: "claude-sonnet-5",
	haiku: "claude-haiku-4-5-20251001",
	"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	opus: "claude-opus-5",
	fable: "claude-fable-5-1",
};

/** Route-table id for a lunR model id or a Claude Code picker value, without the `[1m]` suffix. */
function canonicalRoute(model: string): string {
	const base = model.replace(/\[1m\]$/, "");
	return ROUTE_ALIASES[base] ?? base;
}

/**
 * Claude Code `--model` route for a lunR model id or a Claude Code picker value, or undefined when the
 * pinned release does not know the model.
 */
export function claudeCodeRoute(model: string): string | undefined {
	const canonical = canonicalRoute(model);
	const window = ROUTE_CONTEXT_WINDOWS[canonical];
	if (window === undefined) return undefined;
	if (window < 1_000_000 && model.endsWith("[1m]")) return undefined;
	return window >= 1_000_000 ? `${canonical}[1m]` : canonical;
}

/** Context window Claude Code gives a model on lunR's route, or undefined when the pinned release does not route it. */
export function claudeCodeContextWindow(model: string): number | undefined {
	return ROUTE_CONTEXT_WINDOWS[canonicalRoute(model)];
}
