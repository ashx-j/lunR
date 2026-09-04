// @ts-nocheck
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.ts";

const CUSTOM_TOOL_DESCRIPTION_FILE = "subagent-tool-description.md";
const CUSTOM_TOOL_DESCRIPTION_MAX_BYTES = 50 * 1024;

export const SUBAGENT_SAFETY_GUIDANCE = `SAFETY-CRITICAL SUBAGENT GUIDANCE:
• Prompt children directly. There is no agent roster. Every execution task needs task (the full child prompt) and description (a concise UI label).
• Every executable child also needs tier: "light", "standard", or "heavy". Direct model overrides and parent-model inheritance are not available. A missing, disabled, unconfigured, unavailable, or unauthenticated tier fails before launch.
• permissions is "full" or "read-only". Omitted permissions means full. Plan-mode parents must pass permissions: "read-only"; full or omitted launches are rejected.
• Keep execution and control separate: omit action for SINGLE/PARALLEL/CHAIN execution; use action only for status/interrupt/stop/resume/steer/append-step/doctor/watchdog.*/schedule*.
• Async/background runs: launch with async:true only when work can proceed independently. Do not sleep or poll status just to wait. In an interactive session, normally return control and let lunR wake you; use subagent_wait when this request must run to completion in the current turn or skill. Headless sessions auto-drain current-session work.
• Child-safety boundary: ordinary children are not orchestrators and must not run subagents. Only explicitly configured fanout children may use the child-safe subagent tool, still bounded by depth/session limits.
• Writing/review safety: keep one full-access writer for the same cwd/worktree. Use fresh-context permissions: "read-only" children for independent review, then have the parent synthesize and apply fixes as the sole writer unless an isolated worktree was intentionally requested.
• Artifacts/status essentials: chain outputs live under {chain_dir}; async runs expose asyncId/asyncDir with status.json, events.jsonl, output logs, and status via { action: "status", id }. Include output paths and residual risks when reporting results.`;

export const FULL_SUBAGENT_TOOL_DESCRIPTION = `Delegate work to generic children by prompting them directly. There are no named agent types.

EXECUTION (use exactly ONE mode):
• SINGLE: { task, description, tier, permissions? } — one child. Multiple SINGLE calls in the same turn run concurrently; explicit concurrency/run limits still apply.
• PARALLEL: { tasks: [{task, description, tier, permissions?, count?, output?, reads?, progress?}, ...], concurrency?: number, worktree?: true } — one-call concurrent execution (default: all tasks at once; worktree: isolate each task in a git worktree)
• CHAIN: { chain: [{task, description, tier, permissions?}, {parallel:[{task, description, tier, permissions?, count:3}]}] } — sequential pipeline with optional parallel fan-out. Use chain when a later child needs an earlier result.
• description is required, single-line, max 80 characters. It is UI metadata only. task is the complete child prompt.
• permissions: "full" (default) or "read-only". Full includes coding tools (read, search, shell, edit, write, web, LSP, MCP) and excludes parent-owned tools (cron, memory, behavior, goals, nested subagents). Plan-mode parents may launch only permissions: "read-only".
• Every executable child requires tier: "light", "standard", or "heavy". Direct model overrides and parent-model inheritance are rejected. The configured tier model and credentials must be available.
• Children always start with a fresh session (no inherited parent transcript).
• Optional timeout: { timeoutMs } or { maxRuntimeMs } sets a run-level max runtime for foreground and async/background runs

CHAIN TEMPLATE VARIABLES (use in task and description strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/pi-subagents-<scope>/chain-runs/abc123/)

CHAIN EXAMPLES:
• Sequential: { chain: [{task:"Analyze {task}", description:"Analyze request", tier:"standard"}, {task:"Plan based on {previous}", description:"Draft plan", tier:"heavy"}] }
• Parallel fan-out: { chain: [{parallel: [{task:"Check part of {task}", description:"Check one part", tier:"light", permissions:"read-only", count: 3}]}] }
• Mixed: { chain: [{task:"Research {task}", description:"Research request", tier:"standard", permissions:"read-only"}, {parallel: [{task:"Review {previous}", description:"Review findings", tier:"light", permissions:"read-only", count: 2}]}, {task:"Summarize {previous}", description:"Summarize reviews", tier:"standard"}] }

CONTROL (use action field, omit task/chain/tasks):
• { action: "watchdog.status" | "watchdog.check" | "watchdog.recommend-model" } - inspect the opt-in subagent watchdog and its strong complementary model recommendation
• { action: "watchdog.configure", model: "recommended" | "inherit" | "provider/model[:thinking]", scope?: "session" | "user" | "project", target?: "main" | "children", thinking?: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } - configure watchdog model selection; default scope is session, use persistent scopes only when the user asks
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "status", view: "fleet" } - read-only active foreground/async fleet view with transcript commands
• { action: "status", id: "...", view: "transcript", index?: 0, lines?: 80 } - tail a run or child output/session transcript
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "stop", id: "..." } - stop a current-session top-level async run; stopped runs finish with state "stopped"
• { action: "resume", id: "...", message: "...", index?: 0 } - interrupt then follow up with a live async child, or revive a completed async/foreground child from its session
• { action: "steer", id: "...", message: "...", index?: 0 } - await correlated child input acceptance for up to 3 seconds; returns delivered, scheduled, pending, partial, recovered, or failed with a request id. Only top-level single runs may recover after a further 15-second pause/revival bound; chain, parallel, and nested runs never auto-interrupt.
• { action: "append-step", id: "...", chain: [{task:"Use {previous}", description:"Follow-up step", tier:"standard"}] } - append one step to the tail of a running async chain

SCHEDULE (opt-in; requires { "scheduledRuns": { "enabled": true } } in config.json):
• { action: "schedule", task, description, tier, permissions?, schedule: "+10m" | "2030-01-01T09:00:00Z", scheduleName? } - defer a child launch until a future time. Also accepts tasks[] or chain[]. Scheduled runs always launch async with fresh context; they become normal tracked async runs once they fire. Only schedule explicit delayed runs the user asked for.
• { action: "schedule-list" } - list scheduled runs for this session
• { action: "schedule-status", id: "..." } - inspect one scheduled run
• { action: "schedule-cancel", id: "..." } - cancel a scheduled run before it fires

DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, sessions, and intercom

${SUBAGENT_SAFETY_GUIDANCE}`;

export const COMPACT_SUBAGENT_TOOL_DESCRIPTION = `Delegate to generic children by prompting them. Use exactly one mode per call.

EXECUTE:
• SINGLE {task, description, tier, permissions?} (same-turn singles overlap); PARALLEL {tasks:[{task,description,tier,permissions?,count?,output?,reads?,progress?}], concurrency?, worktree?}; CHAIN {chain:[{task,description,tier,permissions?},{parallel:[...]}]} for sequential work.
• description is required (single-line, max 80 chars, UI only). task is the full child prompt. permissions omitted = full. Plan-mode parents must pass permissions:"read-only".
• Every executable child requires tier:"light"|"standard"|"heavy". Direct model overrides and parent-model inheritance are rejected; tier resolution fails closed. Children always start with a fresh session. timeoutMs/maxRuntimeMs apply to foreground and async/background runs.
• Chain templates may use {task}, {previous}, {chain_dir}, and named outputs. Parallel worktree isolation requires a clean git repo.
• Chain example: { chain: [{task:"Analyze {task}", description:"Analyze request", tier:"standard"}, {parallel: [{task:"Check {previous}", description:"Check prior result", tier:"light", permissions:"read-only", count: 3}]}] }

CONTROL:
• Use action without execution fields: doctor, watchdog.status, watchdog.check, watchdog.recommend-model, watchdog.configure, status, interrupt, stop, resume, steer, append-step.
• Async control actions: status, interrupt, stop, resume, steer, append-step. Use stop with an id for current-session top-level async runs. Use status view:"fleet" for active-run overview, view:"transcript" to tail child output, and steer for acknowledged live guidance. Steering delivery means lunR accepted the correlated user input, not model compliance; use index for a specific child.
• Opt-in schedule actions: schedule, schedule-list, schedule-status, schedule-cancel. Schedule only explicit delayed runs the user asked for.

ASYNC / WAIT:
• async:true detaches background work. Do not sleep or poll just to wait. Interactive sessions normally yield for completion notifications; use subagent_wait for run-to-completion turns or skills. Headless sessions auto-drain current-session work.
• Status and artifacts live under asyncId/asyncDir with status.json, events.jsonl, output logs, session files, and { action:"status", id:"..." }.

SAFETY:
• Ordinary children are not orchestrators and must not run subagents. Only explicit fanout children may use child-safe subagent, still bounded by depth/session limits.
• Keep one full-access writer per cwd/worktree. Use fresh permissions:"read-only" review/validation fanout, then synthesize and apply fixes from the parent unless isolated worktrees were intentionally requested.`;

function isToolDescriptionMode(value: unknown): value is ToolDescriptionMode {
	return value === "full" || value === "compact" || value === "custom";
}

function warn(options: ToolDescriptionOptions | undefined, message: string): void {
	(options?.warn ?? console.warn)(`[pi-subagents] ${message}`);
}

export interface ToolDescriptionOptions {
	cwd?: string;
	agentDir?: string;
	warn?: (message: string) => void;
}

export function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode {
	const mode = config.toolDescriptionMode;
	if (mode === undefined) return "full";
	if (isToolDescriptionMode(mode)) return mode;
	warn(options, `Ignoring invalid toolDescriptionMode ${JSON.stringify(mode)}; expected "full", "compact", or "custom".`);
	return "full";
}

function customDescriptionPaths(options?: ToolDescriptionOptions): string[] {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	return [
		path.join(getProjectConfigDir(cwd), CUSTOM_TOOL_DESCRIPTION_FILE),
		path.join(agentDir, CUSTOM_TOOL_DESCRIPTION_FILE),
	];
}

function renderCustomTemplate(template: string, options?: ToolDescriptionOptions): string {
	const cwd = options?.cwd ?? process.cwd();
	const agentDir = options?.agentDir ?? getAgentDir();
	const projectConfigDir = getProjectConfigDir(cwd);
	const variables: Record<string, () => string> = {
		fullDescription: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		full: () => FULL_SUBAGENT_TOOL_DESCRIPTION,
		compactDescription: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		compact: () => COMPACT_SUBAGENT_TOOL_DESCRIPTION,
		safetyGuidance: () => SUBAGENT_SAFETY_GUIDANCE,
		safety: () => SUBAGENT_SAFETY_GUIDANCE,
		agentDir: () => agentDir,
		projectConfigDir: () => projectConfigDir,
	};
	return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
		const replacement = variables[name];
		if (replacement) return replacement();
		warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE}: unknown placeholder ${raw} left unchanged.`);
		return raw;
	});
}

function loadCustomToolDescription(options?: ToolDescriptionOptions): string | undefined {
	for (const filePath of customDescriptionPaths(options)) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warn(options, `Failed to inspect custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		if (!stat.isFile()) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is not a file.`);
			continue;
		}
		if (stat.size > CUSTOM_TOOL_DESCRIPTION_MAX_BYTES) {
			warn(options, `Ignoring custom tool description '${filePath}' because it is larger than ${CUSTOM_TOOL_DESCRIPTION_MAX_BYTES} bytes.`);
			continue;
		}
		try {
			const template = fs.readFileSync(filePath, "utf-8").trim();
			if (!template) {
				warn(options, `Ignoring empty custom tool description '${filePath}'.`);
				continue;
			}
			const rendered = renderCustomTemplate(template, options).trim();
			if (!rendered) {
				warn(options, `Ignoring custom tool description '${filePath}' because it rendered empty.`);
				continue;
			}
			return rendered;
		} catch (error) {
			warn(options, `Failed to read custom tool description '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

function withMandatorySafetyGuidance(description: string): string {
	const customDescription = description
		.split(SUBAGENT_SAFETY_GUIDANCE)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
	return customDescription
		? `${customDescription}\n\n${SUBAGENT_SAFETY_GUIDANCE}`
		: SUBAGENT_SAFETY_GUIDANCE;
}

export function buildSubagentToolDescription(config: Pick<ExtensionConfig, "toolDescriptionMode"> = {}, options?: ToolDescriptionOptions): string {
	const mode = resolveToolDescriptionMode(config, options);
	let description: string;
	if (mode === "compact") {
		description = COMPACT_SUBAGENT_TOOL_DESCRIPTION;
	} else if (mode === "custom") {
		const custom = loadCustomToolDescription(options);
		if (custom) {
			description = withMandatorySafetyGuidance(custom);
		} else {
			warn(options, `${CUSTOM_TOOL_DESCRIPTION_FILE} was not found or valid for toolDescriptionMode "custom"; using full description.`);
			description = FULL_SUBAGENT_TOOL_DESCRIPTION;
		}
	} else {
		description = FULL_SUBAGENT_TOOL_DESCRIPTION;
	}
	return description;
}
