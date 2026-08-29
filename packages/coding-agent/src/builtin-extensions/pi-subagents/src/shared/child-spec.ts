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
import type { AcceptanceInput, ChildSpec, ChildTier, JsonSchemaObject, ToolBudgetConfig } from "./types.ts";

export type { ChildSpec, ChildTier } from "./types.ts";

export const CHILD_DESCRIPTION_MAX_LENGTH = 80;

export interface DelegatedTaskInput {
	task?: unknown;
	description?: unknown;
	permissions?: unknown;
	model?: unknown;
	tier?: unknown;
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
	const tier = input.tier === "light" || input.tier === "standard" || input.tier === "heavy" ? input.tier : undefined;
	const outputMode = input.outputMode === "inline" || input.outputMode === "file-only" ? input.outputMode : undefined;
	return {
		childId: options.childId ?? allocateChildId(options.runId, options.index),
		task,
		description,
		requestedPermissions: resolved.requested,
		effectivePermissions: resolved.effective,
		model: optionalString(input.model),
		tier,
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
