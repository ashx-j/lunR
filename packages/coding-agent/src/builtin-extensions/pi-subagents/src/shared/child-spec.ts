// @ts-nocheck
/**
 * Normalize model-authored delegated tasks into ChildSpec before validation,
 * rendering, persistence, or process spawning.
 */

import {
	PLAN_MODE_WRITE_SPAWN_ERROR,
	resolveChildPermissions,
	type ChildPermission,
} from "../../../../core/subagent-permission-inherit.ts";
import { resolveChildExcludeTools } from "../runs/shared/child-tools.ts";
import { captureModelSelection, INHERIT_MODEL } from "../runs/shared/model-fallback.ts";
import type { AcceptanceInput, ChildSpec, ChildTier, JsonSchemaObject, ModelSelection, ToolBudgetConfig } from "./types.ts";
import { THINKING_LEVELS } from "./model-info.ts";

export type { ChildSpec, ChildTier, ModelSelection } from "./types.ts";

export const CHILD_DESCRIPTION_MAX_LENGTH = 80;

export interface DelegatedTaskInput {
	task?: unknown;
	description?: unknown;
	permissions?: unknown;
	model?: unknown;
	tier?: unknown;
	thinking?: unknown;
	modelSelection?: unknown;
	skill?: unknown;
	cwd?: unknown;
	output?: unknown;
	outputMode?: unknown;
	acceptance?: unknown;
	toolBudget?: unknown;
	count?: unknown;
	reads?: unknown;
	progress?: unknown;
	label?: unknown;
	phase?: unknown;
	as?: unknown;
	outputSchema?: unknown;
}

export interface NormalizeChildSpecOptions {
	parentMode?: string;
	runId: string;
	index: number;
	childId?: string;
	defaultTask?: string;
	fanoutAuthorized?: boolean;
	pathLabel?: string;
	/** When true, `model` is a previously resolved runtime id and must not be treated as a fresh user selection. */
	resolvedModelIsRuntime?: boolean;
}

export function allocateChildId(runId: string, index: number): string {
	return `${runId}-${index}`;
}

export function sanitizeChildDescription(value: string, max = CHILD_DESCRIPTION_MAX_LENGTH): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

export function validateChildDescription(value: unknown, pathLabel = "description"): string {
	if (typeof value !== "string") {
		throw new Error(`${pathLabel} is required and must be a concise single-line label (max ${CHILD_DESCRIPTION_MAX_LENGTH} characters).`);
	}
	if (/[\r\n]/.test(value)) {
		throw new Error(`${pathLabel} must be a single line with no newlines.`);
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${pathLabel} is required and must be a concise single-line label (max ${CHILD_DESCRIPTION_MAX_LENGTH} characters).`);
	}
	if (trimmed.length > CHILD_DESCRIPTION_MAX_LENGTH) {
		throw new Error(`${pathLabel} must be at most ${CHILD_DESCRIPTION_MAX_LENGTH} characters.`);
	}
	return trimmed;
}

export function parseChildPermissionsInput(value: unknown, pathLabel = "permissions"): ChildPermission | undefined {
	if (value === undefined) return undefined;
	if (value === "full" || value === "read-only") return value;
	throw new Error(`${pathLabel} must be "full" or "read-only".`);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalSkill(value: unknown): string | string[] | false | undefined {
	if (value === false) return false;
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
	return undefined;
}

function optionalOutput(value: unknown): string | false | undefined {
	if (value === false) return false;
	if (typeof value === "string") return value;
	return undefined;
}

function optionalReads(value: unknown): string[] | false | undefined {
	if (value === false) return false;
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
	return undefined;
}

function optionalCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
	return undefined;
}

function isModelSelection(value: unknown): value is ModelSelection {
	if (!value || typeof value !== "object") return false;
	const kind = (value as { kind?: unknown }).kind;
	if (kind === "model") return true;
	if (kind === "tier") {
		const tier = (value as { tier?: unknown }).tier;
		return tier === "light" || tier === "standard" || tier === "heavy";
	}
	return false;
}

function parseThinking(value: unknown, pathLabel: string): string | undefined {
	if (value === undefined) return undefined;
	if (value === false) return "off";
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) return value;
	throw new Error(`${pathLabel}.thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
}

export function normalizeChildSpec(input: DelegatedTaskInput, options: NormalizeChildSpecOptions): ChildSpec {
	const pathLabel = options.pathLabel ?? "task";
	const description = validateChildDescription(input.description, `${pathLabel}.description`);
	const task = typeof input.task === "string" && input.task.trim()
		? input.task
		: options.defaultTask;
	if (typeof task !== "string" || !task.trim()) {
		throw new Error(`${pathLabel}.task is required.`);
	}
	const requested = parseChildPermissionsInput(input.permissions, `${pathLabel}.permissions`);
	const resolved = resolveChildPermissions(options.parentMode, requested);
	if (!resolved.ok) {
		throw new Error(resolved.error || PLAN_MODE_WRITE_SPAWN_ERROR);
	}

	const preservedSelection = isModelSelection(input.modelSelection) ? input.modelSelection : undefined;
	const rawModel = optionalString(input.model);
	if (rawModel === INHERIT_MODEL) {
		throw new Error(`${pathLabel}.model "inherit" is not supported; choose tier or an explicit provider/model.`);
	}

	let modelSelection: ModelSelection;
	let tier: ChildTier | undefined;
	let model: string | undefined;
	let thinking: string | undefined;

	if (preservedSelection) {
		modelSelection = preservedSelection;
		if (modelSelection.kind === "tier") {
			tier = modelSelection.tier;
			// Runtime-resolved models from recovery must not become a fresh user model selection.
			model = undefined;
			if (input.thinking !== undefined) {
				throw new Error(`${pathLabel}.thinking is only valid with an explicit model selection.`);
			}
		} else {
			model = rawModel ?? optionalString(modelSelection.model);
			if (!model) {
				throw new Error(`${pathLabel}.model is required when modelSelection.kind is "model".`);
			}
			if (!modelSelection.model) modelSelection = { kind: "model", model };
			thinking = parseThinking(input.thinking, pathLabel);
		}
	} else if (options.resolvedModelIsRuntime) {
		// Resume/recovery without a stored selection: keep tier routing, ignore resolved model as selection.
		const selectedTier = input.tier === "light" || input.tier === "standard" || input.tier === "heavy" ? input.tier : undefined;
		if (!selectedTier) {
			throw new Error(`${pathLabel}.tier is required to resume a child without a stored modelSelection.`);
		}
		modelSelection = { kind: "tier", tier: selectedTier };
		tier = selectedTier;
		model = undefined;
	} else {
		modelSelection = captureModelSelection({ model: input.model, tier: input.tier });
		if (modelSelection.kind === "tier") {
			tier = modelSelection.tier;
			model = undefined;
			if (input.thinking !== undefined) {
				throw new Error(`${pathLabel}.thinking is only valid with an explicit model selection.`);
			}
		} else {
			model = rawModel;
			if (!modelSelection.model && model) modelSelection = { kind: "model", model };
			thinking = parseThinking(input.thinking, pathLabel);
		}
	}

	const outputMode = input.outputMode === "inline" || input.outputMode === "file-only" ? input.outputMode : undefined;
	return {
		childId: options.childId ?? allocateChildId(options.runId, options.index),
		task,
		description,
		requestedPermissions: resolved.requested,
		effectivePermissions: resolved.effective,
		model,
		tier,
		modelSelection,
		thinking,
		skill: optionalSkill(input.skill),
		cwd: optionalString(input.cwd),
		output: optionalOutput(input.output),
		outputMode,
		acceptance: input.acceptance as AcceptanceInput | undefined,
		toolBudget: input.toolBudget as ToolBudgetConfig | undefined,
		count: optionalCount(input.count),
		reads: optionalReads(input.reads),
		progress: typeof input.progress === "boolean" ? input.progress : undefined,
		label: optionalString(input.label),
		phase: optionalString(input.phase),
		as: optionalString(input.as),
		outputSchema: input.outputSchema && typeof input.outputSchema === "object"
			? input.outputSchema as JsonSchemaObject
			: undefined,
		fanoutAuthorized: options.fanoutAuthorized === true,
	};
}

export function childDisplayLabel(spec: Pick<ChildSpec, "description" | "label">): string {
	return spec.label?.trim() || spec.description;
}

export function tryNormalizeChildSpec(
	input: DelegatedTaskInput,
	options: NormalizeChildSpecOptions,
): { ok: true; spec: ChildSpec } | { ok: false; error: string } {
	try {
		return { ok: true, spec: normalizeChildSpec(input, options) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function childIdentityFields(spec: ChildSpec): {
	childId: string;
	description: string;
	permissions: ChildPermission;
	agent: string;
} {
	return {
		childId: spec.childId,
		description: spec.description,
		permissions: spec.effectivePermissions,
		agent: spec.description,
	};
}

export function childOutputCapabilities(permissions: ChildPermission): { tools: string[] } {
	return permissions === "read-only"
		? { tools: ["read"] }
		: { tools: ["read", "edit", "write", "bash"] };
}

export function childSpawnPiArgDefaults(spec: ChildSpec): {
	inheritProjectContext: true;
	inheritSkills: false;
	systemPromptMode: "append";
	excludeTools: string[];
	childPermission: ChildPermission;
	childId: string;
	childDescription: string;
	childAgentName: string;
} {
	return {
		inheritProjectContext: true,
		inheritSkills: false,
		systemPromptMode: "append",
		excludeTools: resolveChildExcludeTools({
			permissions: spec.effectivePermissions,
			fanoutAuthorized: spec.fanoutAuthorized,
		}),
		childPermission: spec.effectivePermissions,
		childId: spec.childId,
		childDescription: spec.description,
		childAgentName: spec.childId,
	};
}
