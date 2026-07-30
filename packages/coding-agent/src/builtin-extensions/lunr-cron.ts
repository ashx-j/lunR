// @ts-nocheck
/**
 * lunr-cron — lunR-native scheduled jobs (Phase 1: local TUI delivery;
 * Phase 4: gateway delivery + origin stamping).
 *
 * lunR: this file is lunR-native (not an absorbed upstream extension). It wires
 * core/cron (jobs store + scheduler) into the interactive session:
 *
 *  - `/cron list|create|pause|resume|run|remove|status` command.
 *  - One `cron` tool (TypeBox) so the agent can manage jobs. The shared
 *    core/cron/fire-guard depth counter refuses the tool while a cron-fired
 *    turn is in flight — TUI-fired OR gateway-fired (jobs cannot schedule
 *    jobs).
 *  - Jobs created inside a gateway chat turn are stamped with that chat as
 *    their origin and default deliver to "origin" (core/cron/origin-context).
 *  - Scheduler starts on session_start only in "tui" mode, stops on
 *    session_shutdown. runJob = sendUserMessage + wait for agent_end;
 *    deliverResult reads the `@lunr/cron-delivery` bridge on globalThis
 *    (registered here as the local notify; the Phase 4 gateway replaces
 *    it — core/cron/scheduler.ts never touches the bridge itself).
 *
 * `// @ts-nocheck` matches the builtin-extension convention (see lunr-behavior).
 * Runtime imports stay on concrete core modules — never the package barrel.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { beginCronFire, endCronFire, isCronFire } from "../core/cron/fire-guard.ts";
import {
	createJob,
	getJob,
	listJobs,
	parseSchedule,
	pauseJob,
	removeJob,
	resumeJob,
	updateJob,
} from "../core/cron/jobs.ts";
import { currentOrigin } from "../core/cron/origin-context.ts";
import { executeJob, startScheduler } from "../core/cron/scheduler.ts";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
/** The cron-fired turn currently waiting for agent_end. */
let pendingRun: { resolve: (text: string) => void; reject: (err: Error) => void } | null = null;
let scheduler: { stop(): void } | null = null;
let lastCtx: ExtensionContext | null = null;

const DELIVERY_BRIDGE_SYMBOL = Symbol.for("@lunr/cron-delivery");

// ---------------------------------------------------------------------------
// Turn plumbing
// ---------------------------------------------------------------------------

/** Final assistant text from an agent_end messages array (last assistant message, text blocks only). */
function extractAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as any;
		if (msg?.role !== "assistant") continue;
		const parts = Array.isArray(msg.content) ? msg.content : [];
		const text = parts
			.filter((p: any) => p?.type === "text")
			.map((p: any) => String(p.text ?? ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string | null): string {
	if (!iso) return "-";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "-";
	const p = (n: number) => String(n).padStart(2, "0");
	// Stored timestamps are UTC ISO; render in local time so users read wall-clock.
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatJobList(): string {
	const jobs = listJobs();
	if (jobs.length === 0) return "No cron jobs. Create one with /cron create <schedule> <prompt>.";
	const lines = jobs.map(
		(j) =>
			`${j.id}  ${j.state}${j.enabled ? "" : " (disabled)"}  ${j.scheduleDisplay}  next=${fmtTime(j.nextRunAt)}  last=${j.lastStatus ?? "-"}${j.lastError ? ` (${j.lastError})` : ""}  ${j.name}`,
	);
	return `Cron jobs (${jobs.length}):\n${lines.join("\n")}`;
}

function formatStatus(): string {
	const jobs = listJobs();
	const count = (s: string) => jobs.filter((j) => j.state === s).length;
	const next = jobs
		.filter((j) => j.enabled && j.state === "scheduled" && j.nextRunAt)
		.sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0];
	return (
		`Cron: scheduler ${scheduler ? "running" : "stopped"}; ${jobs.length} job(s) — ` +
		`${count("scheduled")} scheduled, ${count("paused")} paused, ${count("completed")} completed, ${count("error")} error.` +
		(next ? ` Next: '${next.name}' at ${fmtTime(next.nextRunAt)}.` : "")
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// --- Local delivery bridge (Phase 4 gateway replaces this) ---
	(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = async (job: { name: string }, _content: string) => {
		try {
			lastCtx?.ui.notify(`Cron job '${job.name}' finished`, "info");
			return null;
		} catch (err) {
			return String((err as Error)?.message ?? err);
		}
	};

	// --- Scheduler deps (TUI) ---
	const runJob = (prompt: string, _job: unknown): Promise<string> => {
		if (pendingRun) return Promise.reject(new Error("another cron job turn is already in flight"));
		return new Promise<string>((resolve, reject) => {
			beginCronFire();
			pendingRun = { resolve, reject };
			try {
				pi.sendUserMessage(prompt);
			} catch (err) {
				pendingRun = null;
				endCronFire();
				reject(err as Error);
			}
		});
	};

	const deliverResult = async (job: any, content: string): Promise<void> => {
		const bridge = (globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] as
			| ((job: unknown, content: string) => Promise<string | null>)
			| undefined;
		if (!bridge) throw new Error("no cron delivery bridge registered");
		const err = await bridge(job, content);
		if (err) throw new Error(String(err));
	};

	const schedulerDeps = { runJob, deliverResult };

	/** Manual trigger: run inline when idle, otherwise make the job due for the next tick. */
	const triggerRun = async (job: any, ctx: ExtensionContext): Promise<string> => {
		if (ctx.isIdle()) {
			void executeJob(getJob(job.id), schedulerDeps).catch(() => {});
			return `Cron job '${job.name}' (${job.id}) started.`;
		}
		await updateJob(job.id, { nextRunAt: new Date().toISOString() });
		return `Cron job '${job.name}' (${job.id}) queued for the next scheduler tick.`;
	};

	// --- Resolve the cron-fired turn when the agent turn ends ---
	pi.on("agent_end", (event) => {
		if (!pendingRun) return;
		const pending = pendingRun;
		pendingRun = null;
		endCronFire();
		pending.resolve(extractAssistantText(event.messages ?? []));
	});

	// --- Scheduler lifecycle: TUI sessions only ---
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") return;
		scheduler?.stop();
		scheduler = startScheduler(schedulerDeps);
	});

	pi.on("session_shutdown", () => {
		scheduler?.stop();
		scheduler = null;
	});

	// --- /cron command ---
	pi.registerCommand("cron", {
		description: "Manage cron jobs: /cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["list", "create", "pause", "resume", "run", "remove", "status"];
			const lower = prefix.toLowerCase();
			return subs
				.filter((s) => s.startsWith(lower))
				.map((s) => ({ value: s, label: s, description: `/cron ${s}` }));
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = (tokens.shift() ?? "list").toLowerCase();
			try {
				switch (sub) {
					case "list": {
						ctx.ui.notify(formatJobList(), "info");
						return;
					}
					case "status": {
						ctx.ui.notify(formatStatus(), "info");
						return;
					}
					case "create": {
						// Greedy: the schedule is the shortest leading token run that parses.
						let used = 0;
						for (let k = 1; k <= Math.min(6, tokens.length); k++) {
							try {
								parseSchedule(tokens.slice(0, k).join(" "));
								used = k;
								break;
							} catch {
								// keep extending
							}
						}
						const prompt = tokens.slice(used).join(" ").trim();
						if (!used || !prompt) {
							ctx.ui.notify("Usage: /cron create <schedule> <prompt> — e.g. /cron create every 30m check the deploy", "error");
							return;
						}
						const job = await createJob({ prompt, schedule: tokens.slice(0, used).join(" ") });
						ctx.ui.notify(`Created cron job '${job.name}' (${job.id}) — ${job.scheduleDisplay}, next run ${fmtTime(job.nextRunAt)}.`, "info");
						return;
					}
					case "pause":
					case "resume":
					case "remove":
					case "run": {
						const idOrName = tokens.join(" ").trim();
						if (!idOrName) {
							ctx.ui.notify(`Usage: /cron ${sub} <id-or-name>`, "error");
							return;
						}
						if (sub === "pause") {
							const job = await pauseJob(idOrName);
							ctx.ui.notify(`Paused cron job '${job.name}' (${job.id}).`, "info");
						} else if (sub === "resume") {
							const job = await resumeJob(idOrName);
							ctx.ui.notify(`Resumed cron job '${job.name}' (${job.id}) — next run ${fmtTime(job.nextRunAt)}.`, "info");
						} else if (sub === "remove") {
							const job = await removeJob(idOrName);
							ctx.ui.notify(`Removed cron job '${job.name}' (${job.id}).`, "info");
						} else {
							const job = getJob(idOrName);
							ctx.ui.notify(await triggerRun(job, ctx), "info");
						}
						return;
					}
					default: {
						ctx.ui.notify("Usage: /cron list | create <schedule> <prompt> | pause|resume|run|remove <id-or-name> | status", "error");
					}
				}
			} catch (err) {
				ctx.ui.notify(String((err as Error)?.message ?? err), "error");
			}
		},
	});

	// --- cron tool (agent-facing) ---
	pi.registerTool({
		name: "cron",
		label: "Cron",
		description: [
			"Manage scheduled cron jobs that run prompts unattended in this session.",
			"Actions: create (needs prompt + schedule), list, update (id + fields), pause, resume, remove, run (trigger now).",
			"Schedule formats: 'every 30m' / 'every 2h' / 'every 1d' (recurring), '30m'/'2h' or an ISO timestamp (one-shot), or a 5-field cron expression.",
			"Job output is delivered automatically; the job's prompt can answer [SILENT] to suppress delivery.",
		].join("\n"),
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("list"),
				Type.Literal("update"),
				Type.Literal("pause"),
				Type.Literal("resume"),
				Type.Literal("remove"),
				Type.Literal("run"),
			]),
			id: Type.Optional(Type.String({ description: "Job id or unique name (all actions except create/list)." })),
			name: Type.Optional(Type.String({ description: "Display name (<=50 chars); derived from the prompt when omitted." })),
			prompt: Type.Optional(Type.String({ description: "The prompt the job runs (create/update)." })),
			schedule: Type.Optional(Type.String({ description: "Schedule input (create/update)." })),
			deliver: Type.Optional(
				Type.String({
					description:
						"Delivery target(s), comma-separated: 'local' (output file only), 'origin' (the chat that created the job), 'telegram'/'discord' (platform home channel), or 'telegram:<chatId>[:<threadId>]' / 'discord:<chatId>[:<threadId>]'. Defaults to 'origin' when created from a gateway chat, else 'local'.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
			if (isCronFire()) {
				return text("cron: unavailable while a cron-fired turn is running (cron jobs cannot schedule cron jobs).");
			}
			try {
				switch (params.action) {
					case "create": {
						if (!params.prompt?.trim() || !params.schedule?.trim()) {
							return text("cron create: prompt and schedule are required.");
						}
						// Inside a gateway chat turn, stamp the chat as the delivery
						// origin and default deliver to "origin" (Phase 4); outside
						// any origin context the default stays "local".
						const origin = currentOrigin();
						const job = await createJob({
							prompt: params.prompt,
							schedule: params.schedule,
							name: params.name,
							deliver: params.deliver ?? (origin ? "origin" : undefined),
							origin: origin ? { ...origin } : undefined,
						});
						return text(`Created cron job '${job.name}' (${job.id}) — ${job.scheduleDisplay}, next run ${fmtTime(job.nextRunAt)}.`);
					}
					case "list": {
						return text(formatJobList());
					}
					case "update": {
						if (!params.id) return text("cron update: id (or unique name) is required.");
						const job = await updateJob(params.id, {
							name: params.name,
							prompt: params.prompt,
							schedule: params.schedule,
							deliver: params.deliver,
						});
						return text(`Updated cron job '${job.name}' (${job.id}) — ${job.scheduleDisplay}, next run ${fmtTime(job.nextRunAt)}.`);
					}
					case "pause": {
						if (!params.id) return text("cron pause: id (or unique name) is required.");
						const job = await pauseJob(params.id);
						return text(`Paused cron job '${job.name}' (${job.id}).`);
					}
					case "resume": {
						if (!params.id) return text("cron resume: id (or unique name) is required.");
						const job = await resumeJob(params.id);
						return text(`Resumed cron job '${job.name}' (${job.id}) — next run ${fmtTime(job.nextRunAt)}.`);
					}
					case "remove": {
						if (!params.id) return text("cron remove: id (or unique name) is required.");
						const job = await removeJob(params.id);
						return text(`Removed cron job '${job.name}' (${job.id}).`);
					}
					case "run": {
						if (!params.id) return text("cron run: id (or unique name) is required.");
						const job = getJob(params.id);
						return text(await triggerRun(job, ctx));
					}
					default:
						return text(`cron: unknown action "${String(params.action)}".`);
				}
			} catch (err) {
				return text(`cron: ${String((err as Error)?.message ?? err)}`);
			}
		},
	});
}
