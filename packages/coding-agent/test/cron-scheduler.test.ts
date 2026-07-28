import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CronJob,
	createJob,
	getJob,
	getLatestJobOutput,
	saveJobOutput,
	setCronBaseDir,
	updateJob,
} from "../src/core/cron/jobs.ts";
import { buildJobPrompt, isSilent, runSchedulerTick, startScheduler } from "../src/core/cron/scheduler.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-cron-sched-"));
	setCronBaseDir(dir);
});

afterEach(() => {
	setCronBaseDir(undefined);
	rmSync(dir, { recursive: true, force: true });
});

function makeDeps(overrides: {
	runJob?: (prompt: string, job: CronJob) => Promise<string>;
	deliverResult?: (job: CronJob, content: string) => Promise<void>;
}) {
	const calls = { run: [] as string[], delivered: [] as string[] };
	const deps = {
		runJob:
			overrides.runJob ??
			(async (prompt: string) => {
				calls.run.push(prompt);
				return "job result";
			}),
		deliverResult:
			overrides.deliverResult ??
			(async (_job: CronJob, content: string) => {
				calls.delivered.push(content);
			}),
	};
	return { deps, calls };
}

async function dueNow(jobId: string): Promise<void> {
	await updateJob(jobId, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
}

describe("isSilent", () => {
	it("matches the whole response or the first/last line only", () => {
		expect(isSilent("[SILENT]")).toBe(true);
		expect(isSilent("  [SILENT]  \n")).toBe(true);
		expect(isSilent("[SILENT]\nsome report")).toBe(true);
		expect(isSilent("some report\n\n[SILENT]")).toBe(true);
		expect(isSilent("some [SILENT] report")).toBe(false);
		expect(isSilent("report")).toBe(false);
	});
});

describe("runSchedulerTick", () => {
	it("advances recurring jobs BEFORE running (at-most-once) and fires only once", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m" });
		await dueNow(job.id);
		const observedNextRunAt: (string | null)[] = [];
		const { deps, calls } = makeDeps({
			runJob: async (prompt: string) => {
				calls.run.push(prompt);
				// advanceNextRun must already have moved nextRunAt into the future.
				observedNextRunAt.push(getJob(job.id).nextRunAt);
				return "ok";
			},
		});
		await runSchedulerTick(deps);
		await runSchedulerTick(deps); // second tick: not due anymore
		expect(calls.run).toHaveLength(1);
		expect(calls.delivered).toEqual(["ok"]);
		expect(new Date(observedNextRunAt[0]!).getTime()).toBeGreaterThan(Date.now() - 1000);
		expect(getJob(job.id).lastStatus).toBe("ok");
		expect(getLatestJobOutput(job.id)).toBe("ok");
	});

	it("suppresses delivery on [SILENT] but still saves output", async () => {
		for (const text of ["[SILENT]", "report body\n[SILENT]", "[SILENT]\nreport body"]) {
			const job = await createJob({ prompt: "p", schedule: "every 30m" });
			await dueNow(job.id);
			const { deps, calls } = makeDeps({ runJob: async () => text });
			await runSchedulerTick(deps);
			expect(calls.delivered).toHaveLength(0);
			expect(getLatestJobOutput(job.id)).toBe(text);
			expect(getJob(job.id).lastStatus).toBe("ok");
			await updateJob(job.id, { enabled: false });
		}
	});

	it("treats an empty response as a soft failure and delivers a one-line error", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m", name: "emptyjob" });
		await dueNow(job.id);
		const { deps, calls } = makeDeps({ runJob: async () => "" });
		await runSchedulerTick(deps);
		const after = getJob(job.id);
		expect(after.lastStatus).toBe("error");
		expect(after.lastError).toBe("empty response");
		expect(calls.delivered).toHaveLength(1);
		expect(calls.delivered[0]).toContain("Cron job 'emptyjob' failed: empty response");
	});

	it("records runJob failures and still attempts failure delivery", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m", name: "boomjob" });
		await dueNow(job.id);
		const { deps, calls } = makeDeps({
			runJob: async () => {
				throw new Error("agent exploded");
			},
		});
		await runSchedulerTick(deps);
		const after = getJob(job.id);
		expect(after.lastStatus).toBe("error");
		expect(after.lastError).toBe("agent exploded");
		expect(calls.delivered[0]).toBe("Cron job 'boomjob' failed: agent exploded");
	});

	it("records delivery errors on the job without failing the run", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m" });
		await dueNow(job.id);
		const { deps } = makeDeps({
			deliverResult: async () => {
				throw new Error("telegram down");
			},
		});
		await runSchedulerTick(deps);
		const after = getJob(job.id);
		expect(after.lastStatus).toBe("ok");
		expect(after.lastDeliveryError).toBe("telegram down");
	});

	it("completes one-shots after firing", async () => {
		const job = await createJob({ prompt: "p", schedule: "30m" });
		await dueNow(job.id);
		const { deps, calls } = makeDeps({});
		await runSchedulerTick(deps);
		expect(calls.run).toHaveLength(1);
		expect(getJob(job.id).state).toBe("completed");
	});
});

describe("buildJobPrompt", () => {
	it("prefixes the cron hint and injects contextFrom outputs capped at 8K", async () => {
		const upstream = await createJob({ prompt: "up", schedule: "every 1h" });
		await saveJobOutput(upstream.id, "x".repeat(9000));
		const job = await createJob({
			prompt: "summarize the above",
			schedule: "every 1h",
			name: "downstream",
			contextFrom: [upstream.id],
		});
		const prompt = buildJobPrompt(job);
		expect(prompt).toContain(
			"You are running as a scheduled cron job 'downstream'. Delivery of your final response is automatic; respond with [SILENT] to suppress delivery.",
		);
		expect(prompt).toContain("summarize the above");
		expect(prompt).toContain("x".repeat(8000));
		expect(prompt).not.toContain("x".repeat(8001));
	});
});

describe("startScheduler", () => {
	it("fires a due job exactly once via the real timer loop", async () => {
		const job = await createJob({ prompt: "p", schedule: "30m" });
		await dueNow(job.id);
		let runs = 0;
		const { deps } = makeDeps({
			runJob: async () => {
				runs++;
				if (runs === 1) return "fired";
				throw new Error("should not run twice");
			},
		});
		const scheduler = startScheduler({ ...deps, intervalMs: 20 });
		try {
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(runs).toBe(1);
			expect(getJob(job.id).state).toBe("completed");
		} finally {
			scheduler.stop();
		}
	});
});
