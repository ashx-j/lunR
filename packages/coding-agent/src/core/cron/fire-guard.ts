/**
 * lunR: shared cron fire guard (Phase 4 of the cron/gateway roadmap).
 *
 * A module-level depth counter marking "a cron-fired agent turn is in flight".
 * The `cron` tool refuses to run while the counter is non-zero so cron jobs
 * cannot schedule cron jobs. Shared between the TUI scheduler (lunr-cron.ts)
 * and the gateway cron runner (gateway/cron.ts) — both increment around the
 * fired turn, so the refusal covers TUI-fired AND gateway-fired turns alike.
 */

let fireDepth = 0;

/** Mark the start of a cron-fired turn. Pairs with endCronFire(). */
export function beginCronFire(): void {
	fireDepth += 1;
}

/** Mark the end of a cron-fired turn. */
export function endCronFire(): void {
	if (fireDepth > 0) fireDepth -= 1;
}

/** True while any cron-fired turn is in flight (nested fires count). */
export function isCronFire(): boolean {
	return fireDepth > 0;
}
