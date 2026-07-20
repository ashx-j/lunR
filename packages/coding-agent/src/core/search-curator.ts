/**
 * Search-curator bridge (consumer side).
 *
 * pi-web-access owns the curator workflow state in its own `web-search.json`
 * (the same file `/curator` writes via `saveConfig`). The extension registers
 * this bridge on `globalThis` at load time; core's /settings "Extensions"
 * submenu reads/writes through it so there is a single source of truth —
 * no forked state in lunR settings.
 */

export const SEARCH_CURATOR_BRIDGE_SYMBOL = Symbol.for("@lunr/search-curator");

/** UI-level setting values exposed in /settings (map to pi-web-access workflows). */
export type SearchCuratorSetting = "off" | "on" | "auto-summary";

export interface SearchCuratorBridge {
	/** Resolved workflow: "none" | "summary-review" | "auto-summary". */
	getWorkflow(): string;
	setWorkflow(workflow: string): void;
}

export function getSearchCuratorBridge(): SearchCuratorBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[SEARCH_CURATOR_BRIDGE_SYMBOL] as SearchCuratorBridge | undefined;
}

/** Current curator setting for the /settings row, or undefined when pi-web-access is not loaded. */
export function getSearchCuratorSetting(): SearchCuratorSetting | undefined {
	const workflow = getSearchCuratorBridge()?.getWorkflow();
	if (workflow === "none") return "off";
	if (workflow === "auto-summary") return "auto-summary";
	if (workflow === "summary-review") return "on";
	return undefined;
}

/** Write a curator setting through the extension's own config path. False when the bridge is absent. */
export function setSearchCuratorSetting(setting: SearchCuratorSetting): boolean {
	const bridge = getSearchCuratorBridge();
	if (!bridge) return false;
	const workflow = setting === "off" ? "none" : setting === "auto-summary" ? "auto-summary" : "summary-review";
	bridge.setWorkflow(workflow);
	return true;
}
