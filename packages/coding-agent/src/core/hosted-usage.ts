import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";

/** A separate usage-only ledger never participates in conversation/context replay. */
export async function recordHostedUsage(message: AssistantMessage, purpose: string): Promise<void> {
	if (process.env.LUNR_HOSTED_USAGE !== "1") return;
	const directory = join(getAgentDir(), "sessions", "_helpers");
	await mkdir(directory, { recursive: true });
	await appendFile(
		join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`),
		`${JSON.stringify({
			type: "message",
			id: randomUUID(),
			purpose,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				provider: message.provider,
				model: message.model,
				responseModel: message.responseModel,
				responseId: message.responseId,
				timestamp: message.timestamp,
				usage: message.usage,
			},
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}
