/**
 * Claude Code's auto-mode verdicts on the tool calls of a Claude subscription answer. The bridge records one
 * per tool call while Claude Code reviews them after the answer ends; lunR's auto mode takes it before the
 * call runs. Browser-safe: no Node imports.
 */
export type ClaudeCodeReview =
	| { decision: "allow" }
	| { decision: "block"; reason: string }
	/** Claude Code did not review the call, for example because auto mode is unavailable for the model. */
	| { decision: "unavailable"; reason: string };

/** Answers whose calls lunR never asks about (reads) would otherwise pile up, so the oldest reviews drop first. */
const MAX_REVIEWS = 256;
const reviews = new Map<string, Promise<ClaudeCodeReview>>();

/** Records the review Claude Code will give `toolCallId`. */
export function trackClaudeCodeReview(toolCallId: string, review: Promise<ClaudeCodeReview>): void {
	reviews.delete(toolCallId);
	reviews.set(toolCallId, review);
	while (reviews.size > MAX_REVIEWS) {
		const oldest = reviews.keys().next();
		if (oldest.done) break;
		reviews.delete(oldest.value);
	}
}

/** Claude Code's review of one tool call, handed out once. Undefined when Claude Code never saw the call in auto mode. */
export function takeClaudeCodeReview(toolCallId: string): Promise<ClaudeCodeReview> | undefined {
	const review = reviews.get(toolCallId);
	reviews.delete(toolCallId);
	return review;
}
