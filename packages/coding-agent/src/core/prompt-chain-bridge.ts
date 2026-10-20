import type { EventBus } from "./event-bus.ts";
import type { ExtensionCommandContext } from "./extensions/types.ts";

/**
 * The prompt-template chain engine as `/chain` sees it. pi-prompt-template-model binds it per runtime;
 * pi-subagents' `/chain` asks `matches` and hands the arguments to `run` when every step names a
 * chain template.
 */
export interface PromptTemplateChains {
	matches(args: string, ctx: ExtensionCommandContext): boolean;
	run(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

const templateChains = new WeakMap<EventBus, PromptTemplateChains>();

export function bindPromptTemplateChains(events: EventBus, chains: PromptTemplateChains): void {
	templateChains.set(events, chains);
}

export function getPromptTemplateChains(events: EventBus): PromptTemplateChains | undefined {
	return templateChains.get(events);
}
