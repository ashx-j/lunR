import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir } from "../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { GitHubPrReader } from "../core/pr-watch/github.ts";
import { parsePrWatchRequest, PR_WATCH_DESCRIPTION, PrWatchParams } from "../core/pr-watch/schema.ts";
import { readPrWatchDuration } from "../core/pr-watch/settings.ts";
import { canonicalPrWatchProject, PrWatchStore } from "../core/pr-watch/store.ts";
import { formatPrWatchBatch, type PrObservation, type PrWatchBatch, type PullRequestIdentity } from "../core/pr-watch/types.ts";
import { PrWatcher } from "../core/pr-watch/watcher.ts";
import { registerSessionWaitInterruption } from "../core/subagent-wait-interruption.ts";

const MESSAGE_TYPE = "pr_watch_update";

function notificationReceipts(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		const details: unknown = entry.type === "custom_message" && entry.customType === MESSAGE_TYPE ? entry.details : entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pr_watch" ? entry.message.details : undefined;
		if (details && typeof details === "object" && "deliveryId" in details && typeof details.deliveryId === "string") ids.add(details.deliveryId);
	}
	return ids;
}

export interface PrWatchExtensionOptions {
	agentDir?: string;
	read?: (pr: PullRequestIdentity, signal: AbortSignal) => Promise<PrObservation>;
}

export function createPrWatchExtension(options: PrWatchExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerPrWatchExtension(pi, options);
}

export default createPrWatchExtension();

function registerPrWatchExtension(pi: ExtensionAPI, options: PrWatchExtensionOptions): void {
	// Children cannot own persistent parent monitoring or expose the user-only controls.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const agentDir = options.agentDir ?? getAgentDir();
	let watcher: PrWatcher | undefined;
	let context: ExtensionContext | undefined;
	let generation = 0;
	let admissionError: string | undefined;
	const deliveries = new Map<string, (received: boolean) => void>();
	const receiptTimers = new Set<ReturnType<typeof setTimeout>>();

	function close(): void {
		generation++;
		for (const timer of receiptTimers) clearTimeout(timer);
		receiptTimers.clear();
		for (const resolve of deliveries.values()) resolve(false);
		deliveries.clear();
		watcher?.close();
		watcher = undefined;
		context = undefined;
	}
	function owner(ctx: ExtensionContext): PrWatcher {
		if (!watcher || !context || ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId() || canonicalPrWatchProject(ctx.cwd) !== canonicalPrWatchProject(context.cwd)) throw new Error(admissionError ?? "PR watching is unavailable outside the owning session/project.");
		return watcher;
	}
	function reconcileReceipts(ctx: ExtensionContext, rejectMissing: boolean): void {
		const receipts = notificationReceipts(ctx);
		for (const id of receipts) watcher?.acknowledgeDelivery(id);
		for (const [id, resolve] of deliveries) {
			if (!receipts.has(id) && !rejectMissing) continue;
			deliveries.delete(id);
			resolve(receipts.has(id));
		}
	}

	pi.on("session_start", (_event, ctx) => {
		close();
		context = ctx;
		admissionError = undefined;
		let store: PrWatchStore | undefined;
		try {
			store = new PrWatchStore(join(agentDir, "pr-watches"), ctx.sessionManager.getSessionId(), canonicalPrWatchProject(ctx.cwd));
			const reader = new GitHubPrReader();
			const activeGeneration = generation;
			watcher = new PrWatcher({
				store,
				read: options.read ?? ((pr, signal) => reader.read(pr, signal)),
				deliver: (batch) => new Promise<boolean>((resolve) => {
					const deliveryId = batch.deliveryId;
					if (generation !== activeGeneration || !context || !deliveryId) { resolve(false); return; }
					deliveries.set(deliveryId, resolve);
					const rejected = () => {
						// A provider can fail after persistence. Only a missing receipt permits replay.
						let received = false;
						if (generation === activeGeneration && context) {
							try { received = notificationReceipts(ctx).has(deliveryId); } catch {}
						}
						deliveries.delete(deliveryId);
						resolve(received);
					};
					try {
						owner(ctx);
						if (!ctx.sendMessage) throw new Error("Owned PR watch message admission unavailable.");
						void ctx.sendMessage({ customType: MESSAGE_TYPE, content: formatPrWatchBatch(batch), display: true, details: batch }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" }).catch(rejected);
					} catch { rejected(); }
				}),
			}, notificationReceipts(ctx));
		} catch (error) {
			store?.close();
			admissionError = error instanceof Error ? error.message : "PR watch ownership/state could not be opened.";
			ctx.ui.notify(admissionError, "warning");
		}
	});
	pi.on("session_shutdown", close);
	pi.on("message_end", (event, ctx) => {
		if (!(event.message.role === "custom" && event.message.customType === MESSAGE_TYPE) && !(event.message.role === "toolResult" && event.message.toolName === "pr_watch")) return;
		const activeGeneration = generation;
		// Core persists message_end after extension hooks; acknowledge on the next timer turn.
		const timer = setTimeout(() => {
			receiptTimers.delete(timer);
			if (activeGeneration === generation && context) reconcileReceipts(ctx, false);
		}, 0);
		receiptTimers.add(timer);
	});
	pi.on("agent_settled", (_event, ctx) => { if (context) reconcileReceipts(ctx, true); });

	pi.registerTool({
		name: "pr_watch", label: "PR watch", description: PR_WATCH_DESCRIPTION, parameters: PrWatchParams,
		async execute(_callId, params, signal, _update, ctx) {
			const request = parsePrWatchRequest(params);
			const active = owner(ctx);
			const watch = request.action === "start" ? active.start(request.url, readPrWatchDuration(agentDir)) : active.list().find((item) => item.id === request.id);
			if (!watch) throw new Error("Unknown watch ID in this session.");
			if (request.action === "start" && !request.wait) return {
				content: [{ type: "text", text: `PR watch ${watch.id}: ${watch.state}. ${watch.pr.url}\nDeadline ${new Date(watch.deadline).toISOString()}. Duplicate starts never restart or extend this watch. Yield for updates or use pr_watch wait with this ID. Monitoring completion does not mean the PR is ready; only the user can cancel/restart through /pr-watch.` }],
				details: { watchId: watch.id, state: watch.state, deadline: watch.deadline },
			};
			const interruption = registerSessionWaitInterruption(ctx.sessionManager.getSessionId());
			try {
				const result = await active.wait(watch.id, interruption ? signal ? AbortSignal.any([signal, interruption.signal]) : interruption.signal : signal);
				return { content: [{ type: "text", text: "interrupted" in result ? "Wait interrupted; PR monitoring remains active until its deadline, PR completion, or user cancellation." : formatPrWatchBatch(result) }], details: "interrupted" in result ? { watchId: watch.id, interrupted: true } : result };
			} finally { interruption?.unregister(); }
		},
		renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold("pr_watch ")) + theme.fg("dim", args.action ?? ""), 0, 0); },
	});
	pi.registerMessageRenderer<PrWatchBatch>(MESSAGE_TYPE, (message, options, theme) => new Text(options.expanded ? message.content as string : theme.fg("dim", `PR watch: ${message.details?.events.length ?? 0} update(s), ${message.details?.state ?? "unknown"}`), 0, 0));
	pi.registerCommand("pr-watch", {
		description: "View PR watches, cancel an ID, or restart an ID with a fresh user window",
		handler: async (args, ctx) => {
			try {
				const active = owner(ctx);
				const parts = args.trim().split(/\s+/).filter(Boolean);
				if (parts.length === 2 && parts[0] === "cancel") active.cancel(parts[1]);
				else if (parts.length === 2 && parts[0] === "restart") active.restart(parts[1], readPrWatchDuration(agentDir));
				else if (parts.length) throw new Error("Use /pr-watch, /pr-watch cancel ID, or /pr-watch restart ID.");
				ctx.ui.notify(active.list().map((watch) => `${watch.id}\n${watch.pr.url}\n${watch.state}; deadline ${new Date(watch.deadline).toISOString()}; head ${watch.head ?? "unknown"}`).join("\n\n") || "No PR watches in this session.", "info");
			} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "PR watch command failed.", "error"); }
		},
	});
}
