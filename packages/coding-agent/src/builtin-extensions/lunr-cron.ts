// @ts-nocheck
/**
 * lunr-cron — lunR-native scheduled jobs (Phase 1: local TUI delivery;
 * Phase 4: gateway delivery + origin stamping).
 *
 * lunR: this file is lunR-native (not an absorbed upstream extension). It wires
 * core/cron (jobs store + scheduler) into the interactive session:
 *
 *  - `/cron list|create|pause|resume|run|remove|rebind|status` command.
 *  - One `cron` tool (TypeBox) so the agent can manage jobs. The shared
 *    core/cron/fire-guard depth counter refuses the tool while a cron-fired
 *    turn is in flight — TUI-fired OR gateway-fired (jobs cannot schedule
 *    jobs).
 *  - Jobs created inside a gateway chat turn are stamped with that chat as
 *    their origin and default deliver to "origin" (core/cron/origin-context).
 *  - Scheduler starts on session_start only in "tui" mode, stops on
 *    session_shutdown. runJob admits and awaits one owned prompt;
 *    TUI delivery notifies locally and records external delivery as unavailable;
 *    the gateway operator performs platform delivery with current grants.
 *
 * `// @ts-nocheck` matches the builtin-extension convention.
 * Runtime imports stay on concrete core modules — never the package barrel.
 */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { beginCronFire, endCronFire, isCronFire } from "../core/cron/fire-guard.ts";
import {
	createJob,
	type CreateJobInput,
	type CronJob,
	getJob,
	listJobs,
	parseSchedule,
	pauseJob,
	removeJob,
	resumeJob,
	setCronDeliverValidator,
	updateJob,
} from "../core/cron/jobs.ts";
import { currentOrigin } from "../core/cron/origin-context.ts";
import { CronAdmissionDeferred, startScheduler } from "../core/cron/scheduler.ts";
import { loadGatewayConfig } from "../gateway/config.ts";
import { createDeliverValidator } from "../gateway/cron.ts";
import { resolveWithinRoots } from "../gateway/mobile-commands.ts";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
/** Last assistant message of this admitted request only. */
function extractAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string; stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> };
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage || `Request ${msg.stopReason}`);
		return (msg.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("").trim();
	}
	return "";
}

/** Both creation routes keep the current project, requester and explicit delivery choice. */
function createInContext(input: CreateJobInput, ctx: ExtensionContext) {
	const origin = currentOrigin();
	const workdir = origin ? resolveWithinRoots(ctx.cwd, loadGatewayConfig().projectRoots ?? []) : ctx.cwd;
	return createJob({ ...input, workdir, origin: origin ? { ...origin } : null, deliver: input.deliver ?? (origin ? "origin" : "local") });
}

/** A TUI owns its current project; it must not silently execute another project's job. */
function requireTuiJobWorkdir(job: CronJob, ctx: ExtensionContext): void {
	if (!job.workdir || !isAbsolute(job.workdir))
		throw new CronAdmissionDeferred("The job has no saved absolute project directory. Recreate it from the intended project before running it in a TUI.");
	let saved: string;
	let current: string;
	try {
		saved = realpathSync(job.workdir);
		current = realpathSync(ctx.cwd);
	} catch {
		throw new CronAdmissionDeferred("The saved or current project directory is unavailable. Restore it before running this job.");
	}
	const matches = process.platform === "win32" ? saved.toLowerCase() === current.toLowerCase() : saved === current;
	if (!matches)
		throw new CronAdmissionDeferred("The job belongs to another project. Run it from a TUI in its saved project, or stop this scheduler so the gateway can own execution.");
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
			`${j.id}  ${j.state}${j.enabled ? "" : " (disabled)"}  ${j.scheduleDisplay}  next=${fmtTime(j.nextRunAt)}  last=${j.lastStatus ?? "-"}${j.lastError ? ` (${j.lastError})` : ""}${j.lastDeliveryError ? ` delivery-error=${j.lastDeliveryError}` : ""}  ${j.name}`,
	);
	return `Cron jobs (${jobs.length}):\n${lines.join("\n")}`;
}

function formatStatus(running: boolean): string {
	const jobs = listJobs();
	const count = (s: string) => jobs.filter((j) => j.state === s).length;
	const next = jobs
		.filter((j) => j.enabled && j.state === "scheduled" && j.nextRunAt)
		.sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0];
	return (
		`Cron: scheduler ${running ? "owner" : "not owner"}; ${jobs.length} job(s) — ` +
		`${count("scheduled")} scheduled, ${count("paused")} paused, ${count("completed")} completed, ${count("error")} error.` +
		(next ? ` Next: '${next.name}' at ${fmtTime(next.nextRunAt)}.` : "")
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	let scheduler: ReturnType<typeof startScheduler> | null = null;
	let lastCtx: ExtensionContext | null = null;
	setCronDeliverValidator((deliver, origin) => createDeliverValidator(loadGatewayConfig())(deliver, origin));

	const deliverResult = async (job: CronJob, _content: string): Promise<void> => {
		if (job.deliver.split(",").some((target) => target.trim() !== "local")) {
			throw new Error("platform delivery unavailable from this TUI operator; restart scheduling in the gateway after stopping this operator");
		}
		lastCtx?.ui.notify(`Cron job '${job.name}' finished`, "info");
	};
	const runJob = async (prompt: string, job: CronJob, signal: AbortSignal): Promise<string> => {
		const ctx = lastCtx;
		if (!ctx?.isIdle() || ctx.hasPendingMessages()) throw new CronAdmissionDeferred("session is busy");
		requireTuiJobWorkdir(job, ctx);
		if (!ctx.promptWithCompletion) throw new Error("owned cron admission unavailable");
		beginCronFire();
		try {
			const result = await ctx.promptWithCompletion(prompt, { source: "extension", signal }).catch((error: unknown) => {
				// Only the runtime's pre-dispatch admission rejection permits a deferred retry.
				if (error instanceof Error && /^Session is busy\. Retry the scheduled prompt after its work settles\.$/.test(error.message)) {
					throw new CronAdmissionDeferred(error.message);
				}
				throw error;
			});
			return extractAssistantText(result.messages);
		} finally { endCronFire(); }
	};
	const schedulerDeps = { runJob, deliverResult, canRun: () => !!lastCtx?.isIdle() && !lastCtx.hasPendingMessages() };
	const triggerRun = async (job: CronJob, _ctx: ExtensionContext): Promise<string> => {
		if (!scheduler) throw new Error("cron runs require the owning TUI operator; use cron run there, or wait for the gateway schedule");
		await scheduler.run(job.id);
		return `Cron job '${job.name}' (${job.id}) finished. Check cron list for run or delivery errors.`;
	};
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (ctx.mode !== "tui") return;
		await scheduler?.stop();
		scheduler = startScheduler(schedulerDeps);
	});
	pi.on("session_shutdown", async () => {
		await scheduler?.stop();
		scheduler = null;
	});

	// --- /cron command ---
	pi.registerCommand("cron", {
		description: "Manage cron jobs: /cron list | create <schedule> <prompt> | pause|resume|run|remove|rebind <id-or-name> | status",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["list", "create", "pause", "resume", "run", "remove", "status", "rebind"];
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
						ctx.ui.notify(formatStatus(scheduler?.isOwner() ?? false), "info");
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
						const job = await createInContext({ prompt, schedule: tokens.slice(0, used).join(" ") }, ctx);
						ctx.ui.notify(`Created cron job '${job.name}' (${job.id}) — ${job.scheduleDisplay}, next run ${fmtTime(job.nextRunAt)}.`, "info");
						return;
					}
					case "rebind":
					case "pause":
					case "resume":
					case "remove":
					case "run": {
						const idOrName = tokens.join(" ").trim();
						if (!idOrName) {
							ctx.ui.notify(`Usage: /cron ${sub} <id-or-name>`, "error");
							return;
						}
						if (sub === "rebind") {
							const origin = currentOrigin();
							if (!origin?.userId) throw new Error("cron rebind requires an approved gateway requester");
							await updateJob(idOrName, { origin: { ...origin } });
							ctx.ui.notify("Cron requester rebound to this gateway chat.", "info");
						} else if (sub === "pause") {
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
						ctx.ui.notify("Usage: /cron list | create <schedule> <prompt> | pause|resume|run|remove|rebind <id-or-name> | status", "error");
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
			"Manage profile-wide scheduled jobs. One operator owns execution; busy sessions defer scheduled work.",
			"TUI execution requires the job's saved project to match the current project. Recreate jobs without a saved project from the intended project.",
			"Actions: create (needs prompt + schedule), list, update (id + fields), pause, resume, remove, run (trigger on the owning TUI operator; otherwise returns an owner error).",
			"Schedule formats: 'every 30m' / 'every 2h' / 'every 1d' (recurring), '30m'/'2h' or an ISO timestamp (one-shot), or a 5-field cron expression.",
			"Job output is saved locally; platform delivery requires the gateway operator and current grants. Legacy origin jobs need rebind from an approved gateway chat. The prompt can answer [SILENT] to suppress delivery.",
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
                        const job = await createInContext({ prompt: params.prompt, schedule: params.schedule, name: params.name, deliver: params.deliver }, ctx);
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
