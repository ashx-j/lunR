import type { Api, Context, Model, Tool } from "../types.ts";

type ToolNameNormalizer = (name: string) => string;

/**
 * Split current tools into prefix and transcript-loaded definitions. A tool a result loaded moves to
 * `deferred`, unless the model called it before that load. For tools in `context.deferredTools`,
 * `declared` says how the provider treats the session's declared set:
 *  - "upFront": the provider advertises it from the first request (Anthropic), so a load always
 *    defers the tool, even after a direct call to it, and the tools prefix stays unchanged.
 *  - "immediate": the provider has no proven load for it (OpenAI), so those tools stay immediate.
 */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
	options: { declared: "upFront" | "immediate"; normalizeName?: ToolNameNormalizer },
): { immediate: Tool[]; deferred: Map<string, Tool> } {
	const normalizeName = options.normalizeName ?? ((name: string) => name);
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);
	if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

	const declaredNames = new Set((context.deferredTools ?? []).map((tool) => normalizeName(tool.name)));
	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(normalizeName(block.name));
			}
		} else if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				const normalizedName = normalizeName(name);
				const isDeclared = declaredNames.has(normalizedName);
				if (isDeclared ? options.declared === "upFront" : !usedNames.has(normalizedName))
					deferredNames.add(normalizedName);
			}
		}
	}

	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}

/**
 * Default for Anthropic's `supportsToolReferences`: first-party Anthropic models except
 * Haiku (rejects client-side tool_reference blocks) and models that predate
 * tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1).
 */
export function defaultSupportsToolReferences(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

/**
 * Whether a session on this model should start rarely used tools unloaded. True only where a load
 * leaves the request prefix unchanged: Anthropic Messages with tool references (API key and Claude
 * subscription), or a model whose `compat.supportsToolReferences` says so. Codex and OpenAI Responses
 * stay off until their undeclared tool-search pair passes a live run. Lives here, not in the Anthropic
 * module, so callers on the first-paint path do not load the Anthropic SDK.
 */
export function supportsDeferredToolLoading(model: Model<Api>): boolean {
	const compat = model.compat;
	const declared = compat && "supportsToolReferences" in compat ? compat.supportsToolReferences : undefined;
	return declared ?? (model.api === "anthropic-messages" && defaultSupportsToolReferences(model));
}
