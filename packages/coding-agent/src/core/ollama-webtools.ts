/**
 * Ollama-webtools bridge (consumer side).
 *
 * pi-ollama-cloud owns the web tools state (`webTools` in its own
 * `ollama-cloud.json`, the same file its session_start init reads via
 * `loadConfig`). The extension registers this bridge on `globalThis` at load
 * time; core's /settings base menu reads/writes through it so there is a
 * single source of truth — no forked state in lunR settings.
 */

export const OLLAMA_WEBTOOLS_BRIDGE_SYMBOL = Symbol.for("@lunr/ollama-webtools");

export interface OllamaWebtoolsBridge {
	/** Current runtime state of the Ollama Cloud web tools. */
	getEnabled(): boolean;
	setEnabled(enabled: boolean): void;
}

export function getOllamaWebtoolsBridge(): OllamaWebtoolsBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[OLLAMA_WEBTOOLS_BRIDGE_SYMBOL] as OllamaWebtoolsBridge | undefined;
}

/** Current web tools state for the /settings row, or undefined when pi-ollama-cloud is not loaded (or env-killed). */
export function getOllamaWebtoolsEnabled(): boolean | undefined {
	return getOllamaWebtoolsBridge()?.getEnabled();
}

/** Write the web tools state through the extension's own config path. False when the bridge is absent. */
export function setOllamaWebtoolsEnabled(enabled: boolean): boolean {
	const bridge = getOllamaWebtoolsBridge();
	if (!bridge) return false;
	bridge.setEnabled(enabled);
	return true;
}
