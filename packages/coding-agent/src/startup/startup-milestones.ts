import { performance } from "node:perf_hooks";

export const STARTUP_MILESTONE_PREFIX = "LUNR_STARTUP_MILESTONE ";

export type StartupMilestoneName =
	| "process_entry"
	| "mode_routed"
	| "input_handler_armed"
	| "raw_mode_active"
	| "first_frame_committed"
	| "runtime_hydrated"
	| "prompt_barrier_open"
	| "deferred_maintenance_idle"
	| "first_provider_request_started";

const enabled = process.env.PI_TIMING === "1" || process.env.PI_STARTUP_BENCHMARK === "1";
const startedAt = performance.now();
const recorded = new Set<StartupMilestoneName>();

export function markStartupMilestone(name: StartupMilestoneName): void {
	if (!enabled || recorded.has(name)) return;
	recorded.add(name);
	const ms = name === "process_entry" ? 0 : performance.now() - startedAt;
	process.stderr.write(`${STARTUP_MILESTONE_PREFIX}${JSON.stringify({ name, ms: Number(ms.toFixed(3)) })}\n`);
}
