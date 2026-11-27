/**
 * The tool registry for AgentSession: which built-in, extension and SDK tools a session may use,
 * wrapped for extension execution, with their prompt snippets and guidelines, and which of them
 * stay active after a rebuild. AgentSession calls `rebuildToolRegistry` on start, extension
 * binding, inline extensions and settings changes, and supplies its tool state through
 * ToolRegistryHost.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ExtensionRunner, type ToolDefinition, wrapRegisteredTools } from "./extensions/index.ts";
import { MEMORY_TOOL_NAMES } from "./memory-cap.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { TODO_TOOL_NAMES } from "./todo-settings.ts";

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/** What a registry rebuild needs from AgentSession. AgentSession builds one in `createToolRegistryHost`. */
export interface ToolRegistryHost {
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner;
	readonly baseToolDefinitions: ReadonlyMap<string, ToolDefinition>;
	readonly customTools: readonly ToolDefinition[];
	readonly allowedToolNames: Set<string> | undefined;
	readonly excludedToolNames: Set<string> | undefined;
	/** Declared deferred tools; they stay unloaded when all extension tools are added. */
	readonly deferredToolNames: readonly string[];
	// Written by the rebuild, in this order, before it sets the active tools.
	toolRegistry: Map<string, AgentTool>;
	toolDefinitions: Map<string, ToolDefinitionEntry>;
	toolPromptSnippets: Map<string, string>;
	toolPromptGuidelines: Map<string, string[]>;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
}

export function rebuildToolRegistry(
	host: ToolRegistryHost,
	options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean },
): void {
	const previousRegistryNames = new Set(host.toolRegistry.keys());
	const previousActiveToolNames = host.getActiveToolNames();
	const allowedToolNames = host.allowedToolNames;
	const excludedToolNames = host.excludedToolNames;
	// bash_job follows bash, so `--tools read,bash` keeps a way to read background jobs.
	const isListed = (names: Set<string>, name: string): boolean =>
		names.has(name) || (name === "bash_job" && names.has("bash"));
	const isAllowedTool = (name: string): boolean =>
		(!allowedToolNames || isListed(allowedToolNames, name)) &&
		!(excludedToolNames && isListed(excludedToolNames, name)) &&
		(host.settingsManager.getMemoryEnabled() || !MEMORY_TOOL_NAMES.has(name)) &&
		(host.settingsManager.getTodosEnabled() || !TODO_TOOL_NAMES.has(name)) &&
		(name !== "browser" || host.settingsManager.getBrowserEnabled());

	const registeredTools = host.extensionRunner.getAllRegisteredTools();
	const allCustomTools = [
		...registeredTools,
		...host.customTools.map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
		})),
	].filter((tool) => isAllowedTool(tool.definition.name));
	const definitionRegistry = new Map<string, ToolDefinitionEntry>(
		Array.from(host.baseToolDefinitions.entries())
			.filter(([name]) => isAllowedTool(name))
			.map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				},
			]),
	);
	for (const tool of allCustomTools) {
		definitionRegistry.set(tool.definition.name, {
			definition: tool.definition,
			sourceInfo: tool.sourceInfo,
		});
	}
	host.toolDefinitions = definitionRegistry;
	host.toolPromptSnippets = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const snippet = normalizePromptSnippet(definition.promptSnippet);
				return snippet ? ([definition.name, snippet] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string] => entry !== undefined),
	);
	host.toolPromptGuidelines = new Map(
		Array.from(definitionRegistry.values())
			.map(({ definition }) => {
				const guidelines = normalizePromptGuidelines(definition.promptGuidelines);
				return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
			})
			.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
	);
	const runner = host.extensionRunner;
	const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
	const wrappedBuiltInTools = wrapRegisteredTools(
		Array.from(host.baseToolDefinitions.values())
			.filter((definition) => isAllowedTool(definition.name))
			.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
			})),
		runner,
	);

	const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
	for (const tool of wrappedExtensionTools as AgentTool[]) {
		toolRegistry.set(tool.name, tool);
	}
	host.toolRegistry = toolRegistry;

	const nextActiveToolNames = (
		options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
	).filter((name) => isAllowedTool(name));

	if (allowedToolNames) {
		for (const toolName of host.toolRegistry.keys()) {
			if (allowedToolNames.has(toolName)) {
				nextActiveToolNames.push(toolName);
			}
		}
	} else if (options?.includeAllExtensionTools) {
		for (const tool of wrappedExtensionTools) {
			// lunr: a declared deferred tool stays unloaded until something loads it.
			if (!host.deferredToolNames.includes(tool.name)) nextActiveToolNames.push(tool.name);
		}
	} else if (!options?.activeToolNames) {
		for (const toolName of host.toolRegistry.keys()) {
			if (!previousRegistryNames.has(toolName)) {
				nextActiveToolNames.push(toolName);
			}
		}
	}

	host.setActiveToolsByName([...new Set(nextActiveToolNames)]);
}

function normalizePromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}
