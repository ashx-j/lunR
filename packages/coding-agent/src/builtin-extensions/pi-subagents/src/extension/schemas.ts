// @ts-nocheck
/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";

function keepTopLevelParameterDescriptions<T>(schema: T): T {
	return pruneNestedDescriptions(schema, []) as T;
}

function pruneNestedDescriptions(value: unknown, path: string[]): unknown {
	if (!value || typeof value !== "object") return value;

	const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		if (key === "description" && !isTopLevelParameterDescription(path)) continue;
		if ("value" in descriptor) {
			const nextPath = typeof key === "string" ? [...path, key] : path;
			descriptor.value = pruneNestedDescriptions(descriptor.value, nextPath);
		}
		Object.defineProperty(result, key, descriptor);
	}
	return result;
}

function isTopLevelParameterDescription(path: string[]): boolean {
	return path.length === 2 && path[0] === "properties";
}

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean", enum: [false] },
		{ type: "string" },
	],
	description: "Skill name(s) to make available (comma-separated), array of strings, or false to disable",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean", enum: [false] },
	],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "Return saved output inline (default) or only a concise file reference. file-only requires output to be a path.",
});

// lunr: required 3-tier subagent routing, resolved through the @lunr/model-tiers bridge.
const TierOverride = Type.String({
	enum: ["light", "standard", "heavy"],
	description: "Required model tier: 'light' for simple/fast work, 'standard' for typical coding, or 'heavy' for complex reasoning. The configured tier model must be available and authenticated.",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean", enum: [false] },
	],
	description: "Files to read before running (array of filenames), or false to disable",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "JSON Schema object for strict structured output. Non-object roots are rejected.",
});

const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "attested", "checked", "verified", "reviewed"] },
		{ type: "boolean", enum: [false] },
		{ type: "object", additionalProperties: true },
	],
	description: "Optional acceptance policy. Omitted means auto-inferred; verified requires configured runtime commands. Reviewed is inferred-only because explicit runs cannot supply an independent reviewer result. Bare \"none\" requires { level: \"none\", reason: \"...\" }, while false is deprecated.",
});

const TurnBudgetOverride = Type.Object({
	maxTurns: Type.Integer({ minimum: 1 }),
	graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false, description: "Optional assistant-turn budget. At maxTurns the child is asked to wrap up; after graceTurns additional assistant turns it is aborted and partial output is returned." });

const ToolBudgetBlock = Type.Unsafe({
	anyOf: [
		{ type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
		{ type: "string", enum: ["*"] },
	],
});

const ToolBudgetOverride = Type.Object({
	soft: Type.Optional(Type.Integer({ minimum: 1 })),
	hard: Type.Integer({ minimum: 1 }),
	block: Type.Optional(ToolBudgetBlock),
}, { additionalProperties: false, description: "Optional child tool-call budget. soft nudges the child; after hard, block tools (default read/grep/find/ls, or '*' for all tools) are blocked so the child can finalize." });

const DescriptionField = Type.String({
	minLength: 1,
	maxLength: 80,
	description: "Required concise single-line UI label (max 80 characters). Presentation metadata only; not used as an identifier.",
});

const PermissionsField = Type.Optional(Type.String({
	enum: ["full", "read-only"],
	description: "Child permission level. Omit or 'full' for coding tools (read/search/shell/edit/write/web/LSP/MCP). 'read-only' inspects without edit/write. Plan-mode parents must pass 'read-only'.",
}));

const TaskItem = Type.Object({
	task: Type.String({ description: "Complete model-authored prompt sent to the child." }),
	description: DescriptionField,
	permissions: PermissionsField,
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking for this task" })),
	tier: TierOverride,
	skill: Type.Optional(SkillOverride),
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
});

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	task: Type.Optional(Type.String({ description: "Task template with {task}, {previous}, {chain_dir} variables. Defaults to {previous}." })),
	description: DescriptionField,
	permissions: PermissionsField,
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this parallel task." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this parallel task N times with the same settings." })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	tier: TierOverride,
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
});

export const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Prior named structured output to expand from." }),
		path: Type.String({ description: "JSON Pointer into the structured output, e.g. /items." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Template variable name for each item. Defaults to item." })),
	key: Type.Optional(Type.String({ description: "JSON Pointer relative to each item for stable child ids." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required fanout bound unless configured globally." })),
	onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Empty input behavior. Defaults to skip." })),
}, { additionalProperties: false });

export const DynamicParallelTemplateSchema = Type.Object({
	task: Type.Optional(Type.String({ description: "Task template with {item}, {item.path}, {task}, {previous}, {chain_dir}, and {outputs.name} variables." })),
	description: Type.String({
		minLength: 1,
		maxLength: 80,
		description: "Required concise single-line UI label. May use the same template variables as task. Maximum 80 characters.",
	}),
	permissions: PermissionsField,
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label; item templates are supported." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	tier: TierOverride,
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
}, { additionalProperties: false });

export const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Safe output name for the ordered collected result array." }),
	outputSchema: Type.Optional(JsonSchemaObject),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
export const ChainItem = Type.Object({
	task: Type.Optional(Type.String({
		description: "Task template with variables: {task}=original request, {previous}=prior step's text response, {chain_dir}=shared folder, {outputs.name}=prior named output. Required for first sequential step, defaults to '{previous}' for subsequent steps."
	})),
	description: Type.Optional(DescriptionField),
	permissions: PermissionsField,
	phase: Type.Optional(Type.String({ description: "Optional phase/group label for status and graph rendering." })),
	label: Type.Optional(Type.String({ description: "Optional user-facing label for this chain step." })),
	as: Type.Optional(Type.String({ description: "Optional safe identifier used as {outputs.name} in later chain steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	skill: Type.Optional(SkillOverride),
	tier: TierOverride,
	toolBudget: Type.Optional(ToolBudgetOverride),
	acceptance: Type.Optional(AcceptanceOverride),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
			DynamicParallelTemplateSchema,
		],
		description: "Static parallel tasks array, or a single dynamic fanout child template when expand/collect are present.",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: unlimited)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for each parallel task."
	})),
}, {
	description: "Chain step: use {task, description, tier, permissions?} for sequential, {parallel: [...]} for static concurrent execution, or {expand, parallel: {...}, collect} for dynamic fanout. Every executable child requires tier.",
	additionalProperties: false,
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable/disable subagent control attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-observed-activity window before a run needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Active-long-running notice threshold by elapsed ms (default: 240000)" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by assistant turns (disabled by default)" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional active-long-running notice threshold by total tokens (disabled by default)" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before escalating to needs_attention (default: 3)" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "Control event types that should notify the parent/orchestrator. Defaults to active_long_running and needs_attention.",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available. Defaults to event, async, and intercom.",
	})),
});

const SubagentParamsSchema = Type.Object({
	task: Type.Optional(Type.String({ description: "Complete model-authored prompt sent to the child (SINGLE mode)." })),
	description: Type.Optional(DescriptionField),
	permissions: PermissionsField,
	// Control action (when present, tool operates in control mode rather than execution)
	action: Type.Optional(Type.String({
		description: "Control action only. Must be omitted for execution mode (single, parallel, or chain). Runtime: status, interrupt, stop, resume, steer, append-step, doctor, watchdog.*, schedule*.",
	})),
	id: Type.Optional(Type.String({
		description: "Run id or prefix for action='status', action='interrupt', action='stop', action='resume', action='steer', or action='append-step'."
	})),
	runId: Type.Optional(Type.String({
		description: "Target run ID for action='interrupt', action='stop', action='resume', action='steer', or action='append-step'. Prefer id for new calls."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run directory for action='status', action='stop', action='resume', or action='steer'."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for actions that target a specific child or transcript." })),
	view: Type.Optional(Type.String({
		enum: ["fleet", "transcript"],
		description: "Optional status view. Use view='fleet' for a read-only active foreground/async fleet surface, or view='transcript' with id/dir (and optional index) to tail a run transcript.",
	})),
	lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum transcript lines for action='status', view='transcript'. Defaults to 80." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for action='resume' or non-terminal guidance for action='steer'. Use index to choose a child from multi-child runs." })),
	scope: Type.Optional(Type.String({ enum: ["session", "user", "project"], description: "Scope for action='watchdog.configure'. Defaults to session to avoid persistent settings writes unless user/project is explicit." })),
	target: Type.Optional(Type.String({ enum: ["main", "children"], description: "Target for action='watchdog.configure'. Defaults to main." })),
	thinking: Type.Optional(Type.Unsafe({ anyOf: [{ type: "string" }, { type: "boolean", enum: [false] }], description: "Thinking level for action='watchdog.configure' (off/minimal/low/medium/high/xhigh/max, inherit, or false for off)." })),
	schedule: Type.Optional(Type.String({ description: "Explicit one-shot schedule for action='schedule'. Only honored when scheduledRuns.enabled is true. Use '+10m' or a future ISO timestamp with timezone; scheduled runs always launch async with fresh context." })),
	scheduleName: Type.Optional(Type.String({ description: "Optional display name for action='schedule'." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: [{task, description, tier, permissions?, count?, output?, outputMode?, reads?, progress?}, ...]" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Top-level PARALLEL mode only: max concurrent tasks. Defaults to config.parallel.concurrency or unlimited." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Create isolated git worktrees for parallel tasks; requires clean git state."
	})),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: sequential steps; each result becomes {previous}. append-step takes one tail step and may use {chain_dir}/{outputs.name}." })),
	context: Type.Optional(Type.String({
		enum: ["fresh"],
		description: "Children always start with a fresh session. Fork context is not available.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Persistent chain artifact directory; defaults to user-scoped temp storage." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Optional run-level timeout in ms for foreground and async/background runs. Alias of maxRuntimeMs." })),
	maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias of timeoutMs for optional run-level timeout in foreground and async/background runs." })),
	turnBudget: Type.Optional(TurnBudgetOverride),
	toolBudget: Type.Optional(ToolBudgetOverride),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist for sharing (default: false)" })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to preview/edit before execution. Explicit clarify: true keeps the run foreground for the clarify UI; omitted clarify can still run in the background when async: true is set." })),
	control: Type.Optional(ControlOverrides),
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean", enum: [false] },
		],
		description: "Output file for a single child (string), or false to disable. Relative paths resolve against cwd.",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	tier: Type.Optional(Type.String({
		enum: ["light", "standard", "heavy"],
		description: "Required for SINGLE execution. Omit for control actions; PARALLEL and CHAIN children carry their own required tier.",
	})),
	acceptance: Type.Optional(AcceptanceOverride),
});

export const SubagentParams = keepTopLevelParameterDescriptions(SubagentParamsSchema);

const SubagentWaitParamsSchema = Type.Object({
	id: Type.Optional(Type.String({
		description: "Async run or remembered detached foreground run id/prefix to wait for one specific run. Omit to wait across every active async run started in this session.",
	})),
	all: Type.Optional(Type.Boolean({
		description: "Wait for ALL active runs to finish. Default false: return as soon as the first run finishes, so a fleet manager can spawn a replacement and wait again. Ignored when id targets a single run.",
	})),
	timeoutMs: Type.Optional(Type.Integer({
		minimum: 1,
		description: "Give up waiting after this many milliseconds (the runs keep going regardless). Defaults to 1800000 (30 minutes).",
	})),
});

export const SubagentWaitParams = keepTopLevelParameterDescriptions(SubagentWaitParamsSchema);
