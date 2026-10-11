import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	type ContentBlock,
	RequestError,
	type SessionUpdate,
	type ToolCallContent,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { CustomMessage } from "../../core/messages.ts";

// adapted from svkozak/pi-acp's prompt and tool translators. see docs/acp.md for attribution.
export function promptToLunr(blocks: ContentBlock[]): { message: string; images: ImageContent[] } {
	const parts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				parts.push(block.text);
				break;
			case "image":
				images.push({ type: "image", mimeType: block.mimeType, data: block.data });
				break;
			case "resource_link":
				parts.push(`[context] ${block.uri}`);
				break;
			case "resource": {
				const resource = block.resource;
				if (!("text" in resource))
					throw new RequestError(
						-32602,
						"Binary embedded resources are not supported. Attach an image or text instead.",
					);
				parts.push(`[embedded context] ${resource.uri}\n${resource.text}`);
				break;
			}
			case "audio":
				throw new RequestError(-32602, "lunr does not support audio prompts.");
		}
	}
	return { message: parts.join("\n"), images };
}

export function toolKind(name: string): ToolKind {
	switch (name) {
		case "read":
			return "read";
		case "find":
		case "grep":
		case "ls":
			return "search";
		case "edit":
		case "write":
		case "code_rewrite":
			return "edit";
		case "bash":
			return "execute";
		case "web_search":
		case "web_fetch":
		case "fetch_content":
			return "fetch";
		case "present_plan":
			return "switch_mode";
		default:
			return "other";
	}
}

export function toolLocations(input: Record<string, unknown>, cwd: string) {
	const path =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	return path ? [{ path: resolve(cwd, path) }] : undefined;
}

export function toolContent(result: {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
}): ToolCallContent[] {
	const content: ToolCallContent[] = [];
	for (const item of result.content) {
		if (item.type === "text" && typeof item.text === "string")
			content.push({ type: "content", content: { type: "text", text: item.text } });
		else if (item.type === "image" && item.data && item.mimeType)
			content.push({ type: "content", content: { type: "image", data: item.data, mimeType: item.mimeType } });
	}
	return content;
}

export function promptTitle(message: string): string {
	return Array.from(message.replace(/\s+/gu, " ").trim()).slice(0, 80).join("");
}

export function customMessageContent(message: CustomMessage) {
	// slash subagent results normally update a tui card and hide the final journal entry.
	if (!message.display && message.customType !== "subagent-slash-result") return [];
	return typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
}

// Native child notices are activity, while extension command replies remain chat content.
export function customMessageUpdates(message: CustomMessage): SessionUpdate[] {
	const content = customMessageContent(message);
	if (!content.length) return [];
	if (message.customType === "subagent-notify") {
		// Journal restoration can change timestamps; content keeps the activity ID stable.
		return [
			{
				sessionUpdate: "tool_call",
				toolCallId: `lunr-subagent-notification-${createHash("sha256").update(JSON.stringify(message.content)).digest("hex")}`,
				title: "lunR subagent notification",
				kind: "other",
				status: "completed",
				content: content.map((content) => ({ type: "content", content })),
			},
		];
	}
	return content.map((content) => ({ sessionUpdate: "agent_message_chunk", content }));
}
