import type { EventBus } from "./event-bus.ts";
import type { PromptTemplate } from "./prompt-templates.ts";

export interface PromptResourceView {
	resources: readonly PromptTemplate[];
	projectTrusted: boolean;
	includeDiscovery: boolean;
	agentDir: string;
}

const promptResources = new WeakMap<EventBus, () => PromptResourceView>();

/** Share approved resource paths and discovery policy with built-ins per runtime. */
export function bindPromptResources(events: EventBus, getResources: () => PromptResourceView): void {
	promptResources.set(events, getResources);
}

export function getPromptResources(events: EventBus): PromptResourceView | undefined {
	return promptResources.get(events)?.();
}
