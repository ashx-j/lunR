import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createJob, getJob, setCronBaseDir, updateJob } from "../src/core/cron/jobs.ts";
import { startScheduler } from "../src/core/cron/scheduler.ts";

// A TUI owner that skips due jobs it cannot run or deliver hands the lease to a gateway,
// then backs off instead of taking it straight back.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-cron-handover-"));
	setCronBaseDir(dir);
});
afterEach(() => {
	setCronBaseDir(undefined);
	rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function dueJob(prompt: string) {
	const job = await createJob({ prompt, schedule: "every 30m" });
	await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	return job;
}

it("a TUI owner hands a job it cannot deliver to a waiting gateway", async () => {
	const job = await dueJob("for the gateway");
	const tui = startScheduler({
		intervalMs: 10,
		handoffBackoffTicks: 1000,
		accepts: () => false,
		runJob: async () => {
			throw new Error("the TUI must not run it");
		},
		deliverResult: async () => {},
	});
	await waitUntil(() => tui.isOwner());
	const ran: string[] = [];
	const gateway = startScheduler({
		intervalMs: 10,
		runJob: async (_prompt, running) => {
			ran.push(running.id);
			return "done";
		},
		deliverResult: async () => {},
	});
	try {
		await waitUntil(() => gateway.isOwner() && getJob(job.id).repeat.completed === 1);
		expect(ran).toEqual([job.id]);
		expect(tui.isOwner()).toBe(false);
	} finally {
		await gateway.stop();
		await tui.stop();
	}
});

it("backs off for the configured ticks, then retakes the lease when nobody took it", async () => {
	await dueJob("nobody can run this");
	// Each call is one owned tick. A retaken lease is held only for the tick that skips the job
	// again, so the test measures the gap between owned ticks instead of polling isOwner().
	const ownedTicks: number[] = [];
	const tui = startScheduler({
		intervalMs: 10,
		handoffBackoffTicks: 5,
		accepts: () => {
			ownedTicks.push(Date.now());
			return false;
		},
		runJob: async () => "unused",
		deliverResult: async () => {},
	});
	try {
		await waitUntil(() => ownedTicks.length === 1 && !tui.isOwner());
		await waitUntil(() => ownedTicks.length >= 2);
		// Five skipped ticks of at least 10ms each before the next owned tick.
		expect(ownedTicks[1]! - ownedTicks[0]!).toBeGreaterThanOrEqual(50);
	} finally {
		await tui.stop();
	}
});

it("keeps the lease when every due job is accepted", async () => {
	const job = await dueJob("local");
	const tui = startScheduler({
		intervalMs: 10,
		handoffBackoffTicks: 5,
		accepts: () => true,
		runJob: async () => "ok",
		deliverResult: async () => {},
	});
	try {
		await waitUntil(() => getJob(job.id).repeat.completed === 1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(tui.isOwner()).toBe(true);
	} finally {
		await tui.stop();
	}
});
