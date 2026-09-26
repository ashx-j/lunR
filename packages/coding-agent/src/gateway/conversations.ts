import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { atomicJson } from "./service.ts";
import type { SessionSource } from "./types.ts";

export interface ConversationBinding {
	cwd?: string;
	owner?: string;
	source: SessionSource;
	recentProjects: string[];
}
const path = () => join(getAgentDir(), "gateway-conversations.json");
export function conversationBindings(): Record<string, ConversationBinding> {
	if (!existsSync(path())) return {};
	const raw: unknown = JSON.parse(readFileSync(path(), "utf8"));
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid gateway conversation store. Restore it before continuing.");
	return raw as Record<string, ConversationBinding>;
}
export function conversationBinding(key: string): ConversationBinding | undefined {
	return conversationBindings()[key];
}
export function bindConversation(
	key: string,
	source: SessionSource,
	options: { cwd?: string; owner?: string } = {},
): void {
	const all = conversationBindings();
	const old = all[key];
	all[key] = {
		...old,
		...options,
		source,
		recentProjects: options.cwd
			? [...new Set([options.cwd, ...(old?.recentProjects ?? [])])].slice(0, 12)
			: (old?.recentProjects ?? []),
	};
	atomicJson(path(), all);
}
