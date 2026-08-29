/**
 * Built-in extensions for lunR.
 *
 * Light factories stay on the first-paint graph. Heavy factories are imported
 * only when attachDeferredBuiltinExtensions() runs after the TUI is up, or
 * immediately for print/RPC/gateway where there is no first-paint window.
 */

import type { ExtensionFactory, InlineExtension } from "../core/extensions/types.ts";

import simplePiMemory from "./simple-pi-memory.ts";
import piTps from "./pi-tps.ts";
import ashxjTui from "./ashxj-tui.ts";
import ashxjSpinners from "./ashxj-spinners.ts";
import ashxjThinking from "./ashxj-thinking.ts";
import lunrLocalProviders from "./lunr-local-providers/index.ts";
import lunrTodos from "./lunr-todos.ts";
import lunrPlanTools from "./lunr-plan-tools.ts";
import lunrSkillCreator from "./lunr-skill-creator/index.ts";

/**
 * Wrap a raw factory function as a named InlineExtension.
 * The cast bridges the gap between the source-level ExtensionFactory type
 * (used here) and the dist-level type that extensions import via the package
 * name. The underlying function signatures are structurally identical.
 */
function ext(name: string, factory: unknown): InlineExtension {
	return { name, factory: factory as ExtensionFactory };
}

/** UI, local providers, and small lunR-native factories. Safe to import at CLI start. */
export const lightBuiltinExtensions: InlineExtension[] = [
	ext("simple-pi-memory", simplePiMemory),
	ext("pi-tps", piTps),
	ext("ashxj-tui", ashxjTui),
	ext("ashxj-spinners", ashxjSpinners),
	ext("ashxj-thinking", ashxjThinking),
	ext("lunr-local-providers", lunrLocalProviders),
	ext("lunr-todos", lunrTodos),
	ext("lunr-plan-tools", lunrPlanTools),
	ext("lunr-skill-creator", lunrSkillCreator),
];

const DEFERRED_BUILTIN_LOADERS: Array<{
	name: string;
	load: () => Promise<{ default: unknown }>;
}> = [
	{ name: "pi-ollama-cloud", load: () => import("./pi-ollama-cloud/index.ts") },
	{ name: "narumiruna-pi-goal", load: () => import("./narumiruna-pi-goal/src/goal.ts") },
	{ name: "lunr-cron", load: () => import("./lunr-cron.ts") },
	{ name: "pi-intercom", load: () => import("./pi-intercom/index.ts") },
	{ name: "pi-prompt-template-model", load: () => import("./pi-prompt-template-model/index.ts") },
	{ name: "pi-subagents", load: () => import("./pi-subagents/index.ts") },
	{ name: "pi-web-access", load: () => import("./pi-web-access/index.ts") },
	{ name: "pi-lsp-extension", load: () => import("./pi-lsp-extension/src/index.ts") },
	{ name: "pi-mcp-adapter", load: () => import("./pi-mcp-adapter/index.ts") },
];

export const DEFERRED_BUILTIN_EXTENSION_NAMES = DEFERRED_BUILTIN_LOADERS.map((entry) => entry.name);

/** Flags registered only after deferred builtins attach. Do not fail CLI parse for these. */
export const DEFERRED_BUILTIN_FLAGS = ["mcp-config"] as const;

/** Import MCP / LSP / web-access / intercom / subagents only when needed. */
export async function loadDeferredBuiltinExtensions(): Promise<InlineExtension[]> {
	const loaded = await Promise.all(
		DEFERRED_BUILTIN_LOADERS.map(async ({ name, load }) => {
			const module = await load();
			return ext(name, module.default);
		}),
	);
	return loaded;
}

/** Full roster. Print / RPC / gateway still need every factory before the first turn. */
export async function loadAllBuiltinExtensions(): Promise<InlineExtension[]> {
	return [...lightBuiltinExtensions, ...(await loadDeferredBuiltinExtensions())];
}

/** Eager full roster. Prefer loadAllBuiltinExtensions() so CLI start stays light. */
export const builtinExtensions: InlineExtension[] = lightBuiltinExtensions;
