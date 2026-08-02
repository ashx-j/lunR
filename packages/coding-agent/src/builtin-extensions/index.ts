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
import ashxjThinking from "./ashxj-thinking.ts";
import piIntercom from "./pi-intercom/index.ts";
import piPromptTemplateModel from "./pi-prompt-template-model/index.ts";
import piSubagents from "./pi-subagents/index.ts";
import piWebAccess from "./pi-web-access/index.ts";
import piLspExtension from "./pi-lsp-extension/src/index.ts";
import piMcpAdapter from "./pi-mcp-adapter/index.ts";

// lunR-native extensions
import lunrLocalProviders from "./lunr-local-providers/index.ts";
import lunrCron from "./lunr-cron.ts";
import lunrBehavior from "./lunr-behavior.ts";
import lunrSkillCreator from "./lunr-skill-creator/index.ts";

// narumiruna extensions (pi-goal kept: plan 2's /goal footer indicator patches it)
import narumirunaGoal from "./narumiruna-pi-goal/src/goal.ts";

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
	ext("ashxj-thinking", ashxjThinking),
	ext("pi-intercom", piIntercom),
	ext("pi-prompt-template-model", piPromptTemplateModel),
	ext("pi-subagents", piSubagents),
	ext("pi-web-access", piWebAccess),
	ext("pi-lsp-extension", piLspExtension),
	ext("pi-mcp-adapter", piMcpAdapter),
	// narumiruna
	ext("narumiruna-pi-goal", narumirunaGoal),
	// lunR-native
	ext("lunr-local-providers", lunrLocalProviders),
	ext("lunr-cron", lunrCron),
	ext("lunr-behavior", lunrBehavior),
	ext("lunr-skill-creator", lunrSkillCreator),
];