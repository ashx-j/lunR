/**
 * Built-in extensions for lunR.
 *
 * These extensions are compiled into the build and loaded as inline factories
 * on every startup. They do not appear as user-installable extensions.
 * Each entry imports the extension's default factory function and registers
 * it as a named InlineExtension so it shows as `<inline:name>` in diagnostics.
 */

import type { ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";

import simplePiMemory from "./simple-pi-memory.ts";
import piTps from "./pi-tps.ts";
import ashxjTui from "./ashxj-tui.ts";
import piOllamaCloud from "./pi-ollama-cloud/index.ts";
import ashxjSpinners from "./ashxj-spinners.ts";
import piIntercom from "./pi-intercom/index.ts";
import piPromptTemplateModel from "./pi-prompt-template-model/index.ts";
import piSubagents from "./pi-subagents/index.ts";
import piWebAccess from "./pi-web-access/index.ts";
import piLspExtension from "./pi-lsp-extension/src/index.ts";
import piMcpAdapter from "./pi-mcp-adapter/index.ts";

// MattDevy extensions
import mattdevyBlueprint from "./mattdevy-pi-blueprint/src/index.ts";
import mattdevyCodeReview from "./mattdevy-pi-code-review/src/index.ts";
import mattdevyCompass from "./mattdevy-pi-compass/src/index.ts";
import mattdevyContinuousLearning from "./mattdevy-pi-continuous-learning/src/index.ts";
import mattdevyRedGreen from "./mattdevy-pi-red-green/src/index.ts";
import mattdevySimplify from "./mattdevy-pi-simplify/src/index.ts";

// narumiruna extensions
import narumirunaBtw from "./narumiruna-pi-btw/src/btw.ts";
import narumirunaCaffeinate from "./narumiruna-pi-caffeinate/src/caffeinate.ts";
import narumirunaChromeDevtools from "./narumiruna-pi-chrome-devtools/src/chrome-devtools.ts";
import narumirunaCodexAccounts from "./narumiruna-pi-codex-accounts/src/codex-accounts.ts";
import narumirunaCodexUsage from "./narumiruna-pi-codex-usage/src/codex-usage.ts";
import narumirunaFirecrawl from "./narumiruna-pi-firecrawl/src/firecrawl.ts";
import narumirunaGithubPr from "./narumiruna-pi-github-pr/src/github-pr.ts";
import narumirunaGoal from "./narumiruna-pi-goal/src/goal.ts";
import narumirunaGoogleGenai from "./narumiruna-pi-google-genai/src/google-genai.ts";
import narumirunaLangfuse from "./narumiruna-pi-langfuse/src/langfuse.ts";
import narumirunaPlanMode from "./narumiruna-pi-plan-mode/src/plan-mode.ts";
import narumirunaRetry from "./narumiruna-pi-retry/src/retry.ts";
import narumirunaSync from "./narumiruna-pi-sync/src/sync.ts";

// context-mode
import contextMode from "./context-mode/adapters/pi/extension.ts";

/**
 * Wrap a raw factory function as a named InlineExtension.
 * The cast bridges the gap between the source-level ExtensionFactory type
 * (used here) and the dist-level type that extensions import via the package
 * name. The underlying function signatures are structurally identical.
 */
function ext(name: string, factory: unknown): InlineExtension {
	return { name, factory: factory as ExtensionFactory };
}

export const builtinExtensions: InlineExtension[] = [
	ext("simple-pi-memory", simplePiMemory),
	ext("pi-tps", piTps),
	ext("ashxj-tui", ashxjTui),
	ext("pi-ollama-cloud", piOllamaCloud),
	ext("ashxj-spinners", ashxjSpinners),
	ext("pi-intercom", piIntercom),
	ext("pi-prompt-template-model", piPromptTemplateModel),
	ext("pi-subagents", piSubagents),
	ext("pi-web-access", piWebAccess),
	ext("pi-lsp-extension", piLspExtension),
	ext("pi-mcp-adapter", piMcpAdapter),
	// MattDevy
	ext("mattdevy-pi-blueprint", mattdevyBlueprint),
	ext("mattdevy-pi-code-review", mattdevyCodeReview),
	ext("mattdevy-pi-compass", mattdevyCompass),
	ext("mattdevy-pi-continuous-learning", mattdevyContinuousLearning),
	ext("mattdevy-pi-red-green", mattdevyRedGreen),
	ext("mattdevy-pi-simplify", mattdevySimplify),
	// narumiruna
	ext("narumiruna-pi-btw", narumirunaBtw),
	ext("narumiruna-pi-caffeinate", narumirunaCaffeinate),
	ext("narumiruna-pi-chrome-devtools", narumirunaChromeDevtools),
	ext("narumiruna-pi-codex-accounts", narumirunaCodexAccounts),
	ext("narumiruna-pi-codex-usage", narumirunaCodexUsage),
	ext("narumiruna-pi-firecrawl", narumirunaFirecrawl),
	ext("narumiruna-pi-github-pr", narumirunaGithubPr),
	ext("narumiruna-pi-goal", narumirunaGoal),
	ext("narumiruna-pi-google-genai", narumirunaGoogleGenai),
	ext("narumiruna-pi-langfuse", narumirunaLangfuse),
	ext("narumiruna-pi-plan-mode", narumirunaPlanMode),
	ext("narumiruna-pi-retry", narumirunaRetry),
	ext("narumiruna-pi-sync", narumirunaSync),
	// context-mode
	ext("context-mode", contextMode),
];