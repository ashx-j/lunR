/**
 * lunR: reusable swarm prompt builder.
 *
 * Moved out of interactive-mode so the gateway can decompose tasks across
 * parallel subagents the same way the TUI does.
 */

export function buildSwarmPrompt(task: string): string {
	return `[SWARM MODE] Task: ${task}
Act as an orchestrator. 1) Decompose into 3-8 independent subtasks. 2) Launch them
in ONE parallel subagent call (async:false), picking an agent + model tier per
subtask (prefer scout for exploration, worker for implementation, reviewer for
verification). 3) Synthesize the results and report. Rules: max 8 concurrent
subagents; no nested fan-out; if a subtask fails, retry once with the heavy tier
before giving up on it; keep your final report under 100 lines with per-subtask
status.`;
}
