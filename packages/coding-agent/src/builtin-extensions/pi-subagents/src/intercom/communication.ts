import type { SubagentState } from "../shared/types.ts";

export const SUPERVISOR_PROTOCOL_ENV = "PI_SUBAGENT_SUPERVISOR_PROTOCOL";
export const CHILD_DESCRIPTION_ENV = "PI_SUBAGENT_CHILD_DESCRIPTION";
export const SUPERVISOR_PROTOCOL_VERSION = 2;
export const SUPERVISOR_REQUEST_TYPE = "subagent_supervisor_request";
export const SUPERVISOR_PROGRESS_TYPE = "subagent_supervisor_progress";

export interface SubagentCommunication {
	direction: "from" | "to";
	peer: string;
	message: string;
	kind: "request" | "interview" | "progress" | "handoff" | "question" | "reply" | "answer" | "steer";
}

export function readCommunication(value: unknown): SubagentCommunication | undefined {
	if (!value || typeof value !== "object") return undefined;
	const input = value as Partial<SubagentCommunication>;
	if (input.direction !== "from" && input.direction !== "to") return undefined;
	if (typeof input.peer !== "string" || typeof input.message !== "string") return undefined;
	if (!["request", "interview", "progress", "handoff", "question", "reply", "answer", "steer"].includes(input.kind ?? "")) return undefined;
	return input as SubagentCommunication;
}

export function supervisorProtocolAvailable(): boolean {
	return process.env[SUPERVISOR_PROTOCOL_ENV] === String(SUPERVISOR_PROTOCOL_VERSION);
}

export function resolveCommunicationPeer(
	state: SubagentState,
	runId: string,
	childIndex: number,
	childId?: string,
	fallback?: string,
): string {
	const job = state.asyncJobs.get(runId) ?? state.fleetJobs?.get(runId);
	const step = job?.steps?.find((candidate, index) =>
		(candidate.index ?? index) === childIndex && (!childId || (candidate.childId ?? candidate.agent) === childId),
	);
	const label = step?.description ?? (step?.agent !== childId ? step?.agent : undefined);
	if (label) {
		const duplicates = job?.steps?.filter((candidate) => (candidate.description ?? candidate.agent) === label).length ?? 0;
		return duplicates > 1 ? `${label} · ${childIndex + 1}` : label;
	}
	const foreground = state.foregroundControls.get(runId);
	if (foreground?.currentIndex === childIndex && (!childId || foreground.currentChildId === childId)) {
		if (foreground.currentAgent && foreground.currentAgent !== childId) return foreground.currentAgent;
	}
	const remembered = state.foregroundRuns?.get(runId)?.children.find((child) => child.index === childIndex);
	if (remembered?.agent && remembered.agent !== childId) return remembered.agent;
	return fallback?.trim() || `Subagent ${childIndex + 1}`;
}

export function legacySupervisorBody(content: string): string {
	return content
		.replace(/^Subagent (?:progress update\.|needs a supervisor decision\.|requests a structured supervisor interview\.)\r?\nRun: [^\n]*\r?\nAgent: [^\n]*\r?\nChild index: [^\n]*\r?\n(?:Child intercom target: [^\n]*\r?\n)?\r?\n/, "")
		.replace(/^Subagent answer \([^\n]*\)\r?\nRun: [^\n]*\r?\nChild: [^\n]*\r?\nDecision: [^\n]*\r?\n\r?\n/, "")
		.replace(/\r?\n\r?\nReply with: subagent_supervisor\([^\n]*\)\s*$/, "");
}
