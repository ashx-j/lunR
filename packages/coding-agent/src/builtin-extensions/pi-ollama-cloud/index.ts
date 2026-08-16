/**
 * Ollama Cloud Provider Extension
 *
 * Registers Ollama Cloud as a model provider with dynamically fetched models.
 *
 * Setup:
 *   1. Get an API key from https://ollama.com
 *   2. Add to auth.json in the agent config dir (~/.pi/agent/auth.json, or set PI_CODING_AGENT_DIR):
 *      { "ollama-cloud": { "type": "api_key", "key": "your-key" } }
 *   3. Run /refresh to fetch model metadata
 *   4. Use /model or ctrl+l to select an Ollama Cloud model
 *
 * Two endpoints are used to build the model list:
 *   - GET  https://ollama.com/v1/models  -> list of model IDs
 *   - POST https://ollama.com/api/show   -> per-model details (capabilities, context length)
 *
 * Raw /api/show responses are cached at <agentDir>/cache/ollama-cloud-models.json
 * so the provider assembly can be debugged and re-derived without re-fetching.
 *
 * Startup behavior:
 *   - Missing cache: uses baked-in GENERATED_MODELS (manually generated via
 *     `npm run generate-models` and committed to the repo).
 *   - Stale or fresh cache: uses the cached data immediately. Cloud fetch only
 *     from /refresh when network is allowed (session_start stays cache-only).
 *
 * Only models with "tools" capability are registered.
 */

import type { ExtensionAPI, ExtensionCommandContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { GENERATED_MODELS } from "./models.generated.ts";
import {
  assembleModels,
  fetchModels,
  OLLAMA_BASE,
  type RefreshProgress,
  readCacheState,
  writeCache,
} from "./models.ts";
// Web tools (ollama_web_search, ollama_web_fetch) excluded — API type mismatches with current pi-coding-agent version. TODO: re-include after updating web-tools.ts to match current AgentToolResult/AuthStorage APIs.
// lunr 2026-08-02: the no-op /settings "Ollama web tools" row, the @lunr/ollama-webtools bridge, and config.ts (webTools key, PI_OLLAMA_WEB_TOOLS) were removed — they toggled state nothing consumed. A leftover "webTools" key in ollama-cloud.json is harmless.

// --- Registrations ---

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]) {
  pi.registerProvider("ollama-cloud", {
    name: "Ollama Cloud",
    baseUrl: `${OLLAMA_BASE}/v1`,
    apiKey: "$OLLAMA_API_KEY",
    api: "openai-completions",
    models,
  });
}

function renderProgressBar(current: number, total: number, width = 15): string {
  if (total <= 0) return `[${"░".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, current / total));
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function createRefreshProgressUi(ctx: Pick<ExtensionCommandContext, "ui">) {
  const key = "ollama-cloud-refresh";
  return {
    update(progress: RefreshProgress) {
      const current = progress.current ?? 0;
      const total = progress.total ?? 0;
      ctx.ui.setWidget(key, [renderProgressBar(current, total)], { placement: "belowEditor" });
    },
    clear() {
      ctx.ui.setWidget(key, undefined);
      ctx.ui.setStatus(key, undefined);
      ctx.ui.setWorkingMessage();
    },
  };
}

async function runRefresh(pi: ExtensionAPI, ctx: Pick<ExtensionCommandContext, "ui">) {
  const progressUi = createRefreshProgressUi(ctx);
  try {
    progressUi.update({ stage: "list", message: "Starting refresh..." });

    const raw = await fetchModels(ctx, (progress) => progressUi.update(progress));
    if (!raw) return false;
    if (Object.keys(raw).length === 0) return false;

    writeCache(raw);
    const newModels = assembleModels(raw);

    registerProvider(pi, newModels);

    ctx.ui.notify(`Registered ${newModels.length} Ollama Cloud models`, "info");
    return true;
  } finally {
    progressUi.clear();
  }
}

// --- Main ---

export default async function (pi: ExtensionAPI) {
  const cacheState = readCacheState();
  // When cache is missing, GENERATED_MODELS serves as the cache —
  // it is manually generated via `npm run generate-models` and committed to the repo.
  // Stale cache is used immediately; Cloud fetch only from /refresh (when network is allowed).
  // GENERATED_MODELS ships with the package (36 tool-capable models from
  // the build script). Used when no local cache exists. A fresh user cache
  // from /refresh takes precedence over the generated list.
  const models = cacheState.status === "missing" ? GENERATED_MODELS : assembleModels(cacheState.models);

  registerProvider(pi, models);
  // lunr: no user-visible command here — /refresh is the single refresh entry
  // point. Core triggers this extension's refresh through the bridge because
  // it bypasses the refreshModels hook and re-registers the provider wholesale.
  (globalThis as Record<symbol, unknown>)[Symbol.for("@lunr/ollama-cloud-refresh")] = (
    ctx: Pick<ExtensionCommandContext, "ui">,
  ) => runRefresh(pi, ctx);
}
