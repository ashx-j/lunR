import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionEntry } from "../../../../core/session-manager.ts";
import { type AccountedRequest, collectUsageRequests, totalRequestUsage } from "../../../../core/usage-accounting.ts";
import type { TokenUsage, Usage } from "./types.ts";

/** Scan all attempts, including older files; stable request IDs prevent fork duplication. */
export function parseSessionRequests(sessionPath: string | undefined): AccountedRequest[] {
	if (!sessionPath) return [];
	try {
		const files = fs.statSync(sessionPath).isDirectory()
			? fs
					.readdirSync(sessionPath)
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => path.join(sessionPath, name))
			: [sessionPath];
		const requests = new Map<string, AccountedRequest>();
		for (const file of files) {
			const entries: SessionEntry[] = [];
			for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
				try {
					const entry = JSON.parse(line) as SessionEntry;
					if (entry?.type) entries.push(entry);
				} catch {
					/* A child may still be flushing its final line. */
				}
			}
			for (const request of collectUsageRequests(entries)) requests.set(request.id, request);
		}
		return [...requests.values()];
	} catch {
		return [];
	}
}

export function parseSessionUsage(sessionPath: string | undefined): Usage | null {
	const requests = parseSessionRequests(sessionPath);
	if (requests.length === 0) return null;
	const total = totalRequestUsage(requests);
	return {
		input: total.input,
		output: total.output,
		cacheRead: total.cacheRead,
		cacheWrite: total.cacheWrite,
		cost: total.cost,
		turns: requests.length,
		unknownRequests: total.unknownRequests,
		partialRequests: total.partialRequests,
		unknownCosts: total.unknownCosts,
	};
}

export function sessionUsageDelta(current: Usage, previous: Usage | null): Usage {
	return {
		unknownRequests: Math.max(0, (current.unknownRequests ?? 0) - (previous?.unknownRequests ?? 0)),
		partialRequests: Math.max(0, (current.partialRequests ?? 0) - (previous?.partialRequests ?? 0)),
		unknownCosts: Math.max(0, (current.unknownCosts ?? 0) - (previous?.unknownCosts ?? 0)),
		input: Math.max(0, current.input - (previous?.input ?? 0)),
		output: Math.max(0, current.output - (previous?.output ?? 0)),
		cacheRead: Math.max(0, current.cacheRead - (previous?.cacheRead ?? 0)),
		cacheWrite: Math.max(0, current.cacheWrite - (previous?.cacheWrite ?? 0)),
		cost: Math.max(0, current.cost - (previous?.cost ?? 0)),
		turns: Math.max(0, current.turns - (previous?.turns ?? 0)),
	};
}

export function tokenUsageFromUsage(usage: Usage): TokenUsage {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		input,
		output: usage.output,
		total: input + usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
}

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const usage = parseSessionUsage(sessionDir);
	return usage ? tokenUsageFromUsage(usage) : null;
}
