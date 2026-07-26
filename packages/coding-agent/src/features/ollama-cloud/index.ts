/**
 * Ollama Cloud provider (absorbed from the former pi-ollama-cloud baked-in
 * extension into core).
 *
 * Registers Ollama Cloud as a model provider with dynamically fetched models:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Raw /api/show responses are cached at <agentDir>/cache/ollama-cloud-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Startup behavior:
 *   - Missing cache: uses baked-in GENERATED_MODELS (committed to the repo).
 *   - Stale cache (>30 days): uses the cached data immediately and triggers a visible
 *     refresh on session start (InteractiveMode calls onOllamaCloudSessionStart).
 *   - Fresh cache: uses cached data directly, no refresh triggered.
 *
 * Only models with "tools" capability are registered.
 *
 * Wiring (no extension events involved anymore):
 * - setupOllamaCloud(modelRuntime) runs in main.ts on every runtime creation,
 *   right after services exist and before model resolution.
 * - The stale-cache startup refresh + web-tools re-apply (formerly two
 *   session_start subscriptions) run from InteractiveMode.rebindCurrentSession
 *   via onOllamaCloudSessionStart.
 * - /ollama-cloud-refresh is a built-in slash command handled by InteractiveMode.
 * - The /settings "Ollama web tools" row reads/writes through the exported
 *   getOllamaWebtoolsEnabled/setOllamaWebtoolsEnabled (formerly the
 *   @lunr/ollama-webtools globalThis bridge). PI_OLLAMA_WEB_TOOLS=false remains
 *   a hard kill switch: both return unavailable/false without touching state.
 *
 * Web tools (ollama_web_search, ollama_web_fetch) stay excluded — API type
 * mismatches with the current pi-coding-agent version. TODO: re-include after
 * updating web-tools.ts to match current AgentToolResult/AuthStorage APIs.
 */

import type { AgentSession } from "../../core/agent-session.ts";
import type { ProviderModelConfig } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { loadConfig, resolveWebToolsEnv, saveConfig } from "./config.ts";
import { GENERATED_MODELS } from "./models.generated.ts";
import {
	assembleModels,
	fetchModels,
	OLLAMA_BASE,
	type RefreshProgress,
	readCacheState,
	writeCache,
} from "./models.ts";

// --- Deps + module state ---

/**
 * Session access for the web-tools active-set and the provider re-registration
 * after a refresh. InteractiveMode configures this with a getter that follows
 * session replacement; before that (and in non-interactive modes) the
 * session-dependent parts no-op, matching an unloaded extension.
 */
export interface OllamaCloudDeps {
	getSession?: () => AgentSession | undefined;
}

let ollamaCloudDeps: OllamaCloudDeps = {};

export function configureOllamaCloudDeps(deps: OllamaCloudDeps): void {
	ollamaCloudDeps = { ...ollamaCloudDeps, ...deps };
}

/** Set by setupOllamaCloud (per runtime creation) from the disk cache state. */
let needsStartupRefresh = false;
let startupRefreshStarted = false;

/**
 * Web-tools state, process-wide. The config file is read once, on the first
 * session start; later sessions reuse webToolsEnabled (including any /settings
 * toggle override). Restart lunr to pick up config file changes.
 */
let webToolsConfigured = false;
let webToolsEnabled = false;

// --- Provider registration ---

function registerOllamaCloudProvider(modelRuntime: ModelRuntime, models: ProviderModelConfig[]): void {
	modelRuntime.registerProvider("ollama-cloud", {
		name: "Ollama Cloud",
		baseUrl: `${OLLAMA_BASE}/v1`,
		apiKey: "$OLLAMA_API_KEY",
		api: "openai-completions",
		models,
	});
}

/**
 * Register the ollama-cloud provider directly on the model runtime. Called
 * from main.ts on every runtime creation (startup + session replacement),
 * right after services exist and before model resolution — the same lifecycle
 * point the extension's registerProvider landed at.
 */
export function setupOllamaCloud(modelRuntime: ModelRuntime): void {
	const cacheState = readCacheState();
	// Auto-refresh only when the disk cache is stale (>30 days).
	// When cache is missing, GENERATED_MODELS serves as the cache.
	needsStartupRefresh = cacheState.status === "stale";
	startupRefreshStarted = false;
	// GENERATED_MODELS ships with the package (tool-capable models from the
	// build script). Used when no local cache exists. A fresh user cache from
	// /ollama-cloud-refresh takes precedence over the generated list.
	const models = cacheState.status === "missing" ? GENERATED_MODELS : assembleModels(cacheState.models);
	registerOllamaCloudProvider(modelRuntime, models);
}

// --- Refresh (startup auto-refresh + /ollama-cloud-refresh) ---

/** UI surface the refresh flow needs (progress widget + working message + notify). */
export interface OllamaCloudRefreshUi {
	notify: (message: string, level?: "info" | "error") => void;
	setWidget: (key: string, content: string[] | undefined, options?: { placement?: "belowEditor" }) => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWorkingMessage: (message?: string) => void;
}

function renderProgressBar(current: number, total: number, width = 15): string {
	if (total <= 0) return `[${"░".repeat(width)}]`;
	const ratio = Math.max(0, Math.min(1, current / total));
	const filled = Math.round(ratio * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function createRefreshProgressUi(ui: OllamaCloudRefreshUi) {
	const key = "ollama-cloud-refresh";
	return {
		update(progress: RefreshProgress) {
			const current = progress.current ?? 0;
			const total = progress.total ?? 0;
			const percent = total > 0 ? Math.round((current / total) * 100) : 0;
			const failed = progress.failed ? `, ${progress.failed} failed` : "";
			const stage =
				progress.stage === "list" ? "Discovering models" : progress.stage === "details" ? "Fetching model details" : "Done";
			const summary = total > 0 ? `${current}/${total} (${percent}%${failed})` : progress.message;
			const line = `☁ Ollama Cloud - ${stage} — ${summary} ${renderProgressBar(current, total)}`;

			ui.setWorkingMessage(`Refreshing Ollama Cloud models - ${stage.toLowerCase()}`);
			ui.setWidget(key, [line], { placement: "belowEditor" });
		},
		clear() {
			ui.setWidget(key, undefined);
			ui.setStatus(key, undefined);
			ui.setWorkingMessage();
		},
	};
}

/**
 * Fetch + cache + re-register the Ollama Cloud model list, with progress in
 * the widget. Drives both the stale-cache startup refresh and the
 * /ollama-cloud-refresh command.
 */
export async function runOllamaCloudRefresh(ui: OllamaCloudRefreshUi): Promise<boolean> {
	const progressUi = createRefreshProgressUi(ui);
	try {
		progressUi.update({ stage: "list", message: "Starting refresh..." });

		const raw = await fetchModels(
			(message, level) => ui.notify(message, level),
			(progress) => progressUi.update(progress),
		);
		if (!raw) return false;

		writeCache(raw);
		const newModels = assembleModels(raw);

		const modelRuntime = ollamaCloudDeps.getSession?.()?.modelRuntime;
		if (modelRuntime) {
			registerOllamaCloudProvider(modelRuntime, newModels);
		}

		ui.notify(`Registered ${newModels.length} Ollama Cloud models`, "info");
		return true;
	} finally {
		progressUi.clear();
	}
}

// --- Web tools management ---

/**
 * Ensure web tools are registered (idempotent).
 * Returns true if any tools were newly registered.
 */
function ensureWebToolsRegistered(): boolean {
	// Web tools excluded — see note at top of file.
	return false;
}

const WEB_TOOL_NAMES = ["ollama_web_search", "ollama_web_fetch"];

/**
 * Add or remove web tools from the active tools set.
 */
function setWebToolsActive(active: boolean): void {
	const session = ollamaCloudDeps.getSession?.();
	if (!session) return;
	const currentActive = session.getActiveToolNames();

	if (active) {
		const missing = WEB_TOOL_NAMES.filter((n) => !currentActive.includes(n));
		if (missing.length > 0) {
			session.setActiveToolsByName([...currentActive, ...missing]);
		}
	} else {
		const filtered = currentActive.filter((t) => !WEB_TOOL_NAMES.includes(t));
		if (filtered.length < currentActive.length) {
			session.setActiveToolsByName(filtered);
		}
	}
}

/**
 * Session-start lifecycle (formerly two session_start subscriptions). Called
 * by InteractiveMode.rebindCurrentSession on startup and every session
 * replacement: runs the stale-cache startup refresh once per runtime creation,
 * then re-applies the web-tools runtime state (tools may have been
 * unregistered during teardown).
 */
export async function onOllamaCloudSessionStart(ui: OllamaCloudRefreshUi): Promise<void> {
	if (needsStartupRefresh && !startupRefreshStarted) {
		startupRefreshStarted = true;
		await runOllamaCloudRefresh(ui);
	}

	if (!webToolsConfigured) {
		webToolsConfigured = true;
		const config = loadConfig(ollamaCloudDeps.getSession?.()?.sessionManager.getCwd() ?? process.cwd());
		if (config.webTools !== false) {
			webToolsEnabled = true;
			ensureWebToolsRegistered();
		}
	}
	if (webToolsEnabled) {
		ensureWebToolsRegistered();
		setWebToolsActive(true);
	}
}

/**
 * Current web tools state for the /settings row, or undefined when the
 * PI_OLLAMA_WEB_TOOLS=false kill switch suppresses the setting (row shows
 * "unavailable", same as the old absent bridge).
 */
export function getOllamaWebtoolsEnabled(): boolean | undefined {
	if (resolveWebToolsEnv() === false) return undefined;
	return webToolsEnabled;
}

/**
 * Write the web tools state: applies the same runtime behavior as the old
 * /ollama-webtools command AND persists through ollama-cloud.json saveConfig —
 * single source of truth, no forked state. Returns false when the
 * PI_OLLAMA_WEB_TOOLS=false kill switch suppresses the setting.
 */
export function setOllamaWebtoolsEnabled(enabled: boolean): boolean {
	if (resolveWebToolsEnv() === false) return false;
	webToolsEnabled = enabled;
	if (enabled) {
		ensureWebToolsRegistered();
		setWebToolsActive(true);
	} else {
		setWebToolsActive(false);
	}
	saveConfig({ webTools: enabled });
	return true;
}
