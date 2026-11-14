import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

export const REQUEST_USAGE_TYPE = "request-usage";

export interface AccountedRequest {
	id: string;
	purpose: string;
	provider: string;
	model: string;
	timestamp: number;
	usage: Usage;
	stopReason: AssistantMessage["stopReason"];
}

export interface UsageTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	unknownRequests: number;
	partialRequests: number;
	unknownCosts: number;
}

export function emptyUsageTotals(): UsageTotals {
	return {
		requests: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: 0,
		unknownRequests: 0,
		partialRequests: 0,
		unknownCosts: 0,
	};
}

export function usageTokens(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** All incurred requests, independent of the active conversation branch. */
export function collectUsageRequests(entries: readonly SessionEntry[]): AccountedRequest[] {
	const requests = new Map<string, AccountedRequest>();
	for (const entry of entries) {
		if (entry.inherited) continue;
		let request: AccountedRequest | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const message = entry.message;
			if (!validUsage(message.usage)) continue;
			request = {
				id: message.usage.requestId ?? `${entry.id}:${entry.timestamp}:${message.provider}/${message.model}`,
				purpose: "conversation",
				provider: message.provider,
				model: message.responseModel ?? message.model,
				timestamp: Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : message.timestamp,
				usage: message.usage,
				stopReason: message.stopReason,
			};
		} else if (entry.type === "custom" && entry.customType === REQUEST_USAGE_TYPE) {
			const data = entry.data as AccountedRequest | undefined;
			if (validRequest(data)) request = data;
		}
		if (request && validRequest(request)) requests.set(request.id, request);
	}
	return [...requests.values()];
}

export function totalRequestUsage(requests: readonly AccountedRequest[]): UsageTotals {
	const total = emptyUsageTotals();
	total.requests = requests.length;
	for (const { usage } of requests) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.total += usageTokens(usage);
		total.cost += usage.cost.total;
		total.unknownRequests += Number(usage.measurement === "unknown");
		total.partialRequests += Number(usage.measurement === "partial");
		total.unknownCosts += Number(usage.costSource === "unknown");
	}
	return total;
}

export interface ChildUsageSnapshot {
	id: string;
	label: string;
	sessionFile?: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	unknownRequests: number;
	partialRequests: number;
	unknownCosts: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function validUsage(value: unknown): value is Usage {
	const usage = record(value);
	const cost = record(usage?.cost);
	return Boolean(
		usage &&
			cost &&
			[usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost.total].every(
				(amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0,
			),
	);
}

function validRequest(value: unknown): value is AccountedRequest {
	const request = record(value);
	return Boolean(
		request &&
			typeof request.id === "string" &&
			request.id &&
			validUsage(request.usage) &&
			typeof request.timestamp === "number" &&
			Number.isFinite(request.timestamp),
	);
}
/** Request IDs deduplicate completion, wait, fallback, resume, and inherited receipts. Legacy receipts use cumulative counters. */
export function collectChildUsage(entries: readonly SessionEntry[]): ChildUsageSnapshot[] {
	const children = new Map<string, ChildUsageSnapshot>();
	const inherited = new Map<string, ChildUsageSnapshot>();
	const requestGroups = new Map<string, Map<string, AccountedRequest>>();
	const inheritedRequestIds = new Set<string>();
	const requestOwners = new Map<string, string>();
	for (const entry of entries) {
		const details =
			entry.type === "custom_message" && ["subagent-notify", "subagent-slash-result"].includes(entry.customType)
				? record(entry.details)
				: entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName?.startsWith("subagent")
					? record(entry.message.details)
					: undefined;
		if (!details) continue;
		const slash = record(record(details.result)?.details);
		const candidates = details.children ?? slash?.results ?? details.results;
		if (!Array.isArray(candidates)) continue;
		for (const candidate of candidates) {
			const child = record(candidate);
			const usage = record(child?.usage);
			if (!child || !usage) continue;
			const identity = child.sessionFile ?? child.childId ?? child.id;
			if (typeof identity !== "string" || !identity) continue;
			const snapshot: ChildUsageSnapshot = {
				id: identity,
				label: String(child.description ?? child.agent ?? "child"),
				sessionFile: typeof child.sessionFile === "string" ? child.sessionFile : undefined,
				input: amount(usage.input),
				output: amount(usage.output),
				cacheRead: amount(usage.cacheRead),
				cacheWrite: amount(usage.cacheWrite),
				cost: amount(usage.cost),
				turns: amount(usage.turns),
				unknownRequests: amount(usage.unknownRequests),
				partialRequests: amount(usage.partialRequests),
				unknownCosts: amount(usage.unknownCosts),
			};
			if (Array.isArray(child.usageRequests)) {
				const requests = requestGroups.get(identity) ?? new Map<string, AccountedRequest>();
				requestGroups.set(identity, requests);
				for (const request of child.usageRequests) {
					if (!validRequest(request)) continue;
					if (entry.inherited) inheritedRequestIds.add(request.id);
					else if (!requestOwners.has(request.id) || requestOwners.get(request.id) === identity) {
						requestOwners.set(request.id, identity);
						requests.set(request.id, request);
					}
				}
			}
			const target = entry.inherited ? inherited : children;
			const previous = target.get(identity);
			// A stale receipt must not undo a newer cumulative receipt.
			if (!previous || usageTokens(snapshot) >= usageTokens(previous)) target.set(identity, snapshot);
		}
	}
	return [...children.values()].map((child) => {
		const requests = requestGroups.get(child.id);
		if (requests) {
			const ownRequests = [...requests.values()].filter((request) => !inheritedRequestIds.has(request.id));
			const total = totalRequestUsage(ownRequests);
			return {
				...child,
				input: total.input,
				output: total.output,
				cacheRead: total.cacheRead,
				cacheWrite: total.cacheWrite,
				cost: total.cost,
				turns: ownRequests.length,
				unknownRequests: total.unknownRequests,
				partialRequests: total.partialRequests,
				unknownCosts: total.unknownCosts,
			};
		}
		const baseline = inherited.get(child.id);
		if (!baseline) return child;
		const own = { ...child };
		for (const key of [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cost",
			"turns",
			"unknownRequests",
			"partialRequests",
			"unknownCosts",
		] as const)
			own[key] = Math.max(0, child[key] - baseline[key]);
		return own;
	});
}

export function totalChildUsage(children: readonly ChildUsageSnapshot[]): UsageTotals {
	const totals = emptyUsageTotals();
	for (const child of children) {
		totals.requests += child.turns;
		totals.input += child.input;
		totals.output += child.output;
		totals.cacheRead += child.cacheRead;
		totals.cacheWrite += child.cacheWrite;
		totals.total += usageTokens(child);
		totals.cost += child.cost;
		totals.unknownRequests += child.unknownRequests;
		totals.partialRequests += child.partialRequests;
		totals.unknownCosts += child.unknownCosts;
	}
	return totals;
}
