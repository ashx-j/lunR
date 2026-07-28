import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	advanceNextRun,
	type CronJob,
	computeNextRun,
	createJob,
	getDueJobs,
	getJob,
	getLatestJobOutput,
	listJobs,
	markJobRun,
	OUTPUT_RETENTION,
	parseSchedule,
	pauseJob,
	removeJob,
	resumeJob,
	saveJobOutput,
	setCronBaseDir,
	updateJob,
} from "../src/core/cron/jobs.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-cron-jobs-"));
	setCronBaseDir(dir);
});

afterEach(() => {
	setCronBaseDir(undefined);
	rmSync(dir, { recursive: true, force: true });
});

function makeJob(partial: Partial<CronJob>): CronJob {
	return {
		id: "job1",
		name: "job1",
		prompt: "do a thing",
		schedule: { kind: "interval", minutes: 30 },
		scheduleDisplay: "every 30m",
		repeat: { times: null, completed: 0 },
		enabled: true,
		state: "scheduled",
		createdAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastDeliveryError: null,
		deliver: "local",
		...partial,
	};
}

describe("parseSchedule", () => {
	it("parses 'every 30m' / 'every 2h' / 'every 1d' as intervals in minutes", () => {
		expect(parseSchedule("every 30m").schedule).toEqual({ kind: "interval", minutes: 30 });
		expect(parseSchedule("every 2h").schedule).toEqual({ kind: "interval", minutes: 120 });
		expect(parseSchedule("every 1d").schedule).toEqual({ kind: "interval", minutes: 1440 });
		expect(parseSchedule("every 2h").scheduleDisplay).toBe("every 2h");
	});

	it("parses bare durations as one-shots at now + duration", () => {
		const now = new Date("2026-01-01T00:00:00.000Z");
		const parsed = parseSchedule("45m", now);
		expect(parsed.schedule.kind).toBe("once");
		expect(parsed.schedule.runAt).toBe("2026-01-01T00:45:00.000Z");
		expect(parseSchedule("2h", now).schedule.runAt).toBe("2026-01-01T02:00:00.000Z");
		expect(parseSchedule("1d", now).schedule.runAt).toBe("2026-01-02T00:00:00.000Z");
	});

	it("parses ISO timestamps as one-shots", () => {
		const parsed = parseSchedule("2030-05-01T10:00:00.000Z");
		expect(parsed.schedule).toEqual({ kind: "once", runAt: "2030-05-01T10:00:00.000Z" });
	});

	it("parses 5-field cron expressions", () => {
		const parsed = parseSchedule("*/15 * * * *");
		expect(parsed.schedule).toEqual({ kind: "cron", expr: "*/15 * * * *" });
		expect(parsed.scheduleDisplay).toBe("*/15 * * * *");
	});

	it("throws on invalid input", () => {
		expect(() => parseSchedule("")).toThrow();
		expect(() => parseSchedule("soon")).toThrow();
		expect(() => parseSchedule("every 10x")).toThrow();
		expect(() => parseSchedule("* * * *")).toThrow(); // 4 fields
		expect(() => parseSchedule("99 * * * *")).toThrow(); // invalid cron value
		expect(() => parseSchedule("x * * * *")).toThrow(); // invalid cron char
	});
});

describe("computeNextRun", () => {
	const now = new Date("2026-01-01T00:10:00.000Z");

	it("once: returns runAt when never run and within the 120s grace", () => {
		const future = makeJob({ schedule: { kind: "once", runAt: "2026-01-01T00:30:00.000Z" } });
		expect(computeNextRun(future, now)?.toISOString()).toBe("2026-01-01T00:30:00.000Z");
		const recentPast = makeJob({ schedule: { kind: "once", runAt: "2026-01-01T00:08:20.000Z" } }); // 100s ago
		expect(computeNextRun(recentPast, now)?.toISOString()).toBe("2026-01-01T00:08:20.000Z");
	});

	it("once: null beyond the 120s grace or after running", () => {
		const missed = makeJob({ schedule: { kind: "once", runAt: "2026-01-01T00:06:40.000Z" } }); // 200s ago
		expect(computeNextRun(missed, now)).toBeNull();
		const ran = makeJob({
			schedule: { kind: "once", runAt: "2026-01-01T00:30:00.000Z" },
			repeat: { times: 1, completed: 1 },
		});
		expect(computeNextRun(ran, now)).toBeNull();
	});

	it("interval: createdAt + minutes when never run, lastRunAt + minutes after", () => {
		const fresh = makeJob({ schedule: { kind: "interval", minutes: 30 } });
		expect(computeNextRun(fresh, now)?.toISOString()).toBe("2026-01-01T00:30:00.000Z");
		const ran = makeJob({ schedule: { kind: "interval", minutes: 30 }, lastRunAt: "2026-01-01T00:05:00.000Z" });
		expect(computeNextRun(ran, now)?.toISOString()).toBe("2026-01-01T00:35:00.000Z");
	});

	it("cron: next slot after lastRunAt ?? now", () => {
		const fresh = makeJob({ schedule: { kind: "cron", expr: "*/15 * * * *" } });
		expect(computeNextRun(fresh, now)?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
		const ran = makeJob({ schedule: { kind: "cron", expr: "*/15 * * * *" }, lastRunAt: "2026-01-01T00:15:00.000Z" });
		expect(computeNextRun(ran, now)?.toISOString()).toBe("2026-01-01T00:30:00.000Z");
	});
});

describe("CRUD + store", () => {
	it("creates jobs with derived name, defaults, and a computed nextRunAt", async () => {
		const job = await createJob({ prompt: "check the deploy status please", schedule: "every 30m" });
		expect(job.id).toMatch(/^[0-9a-f]{12}$/);
		expect(job.name).toBe("check the deploy status please");
		expect(job.deliver).toBe("local");
		expect(job.enabled).toBe(true);
		expect(job.state).toBe("scheduled");
		expect(job.repeat).toEqual({ times: null, completed: 0 });
		expect(job.nextRunAt).not.toBeNull();
	});

	it("one-shots get repeat.times = 1", async () => {
		const job = await createJob({ prompt: "once", schedule: "30m" });
		expect(job.repeat.times).toBe(1);
	});

	it("truncates derived names to 50 chars", async () => {
		const job = await createJob({ prompt: "x".repeat(120), schedule: "every 1h" });
		expect(job.name).toHaveLength(50);
	});

	it("looks up by id or unique name; ambiguous names throw", async () => {
		const a = await createJob({ prompt: "first", schedule: "every 1h", name: "dup" });
		await createJob({ prompt: "second", schedule: "every 1h", name: "dup" });
		const c = await createJob({ prompt: "third", schedule: "every 1h", name: "solo" });
		expect(getJob(a.id).id).toBe(a.id);
		expect(getJob("solo").id).toBe(c.id);
		expect(() => getJob("dup")).toThrow(/ambiguous/);
		expect(() => getJob("nope")).toThrow(/no cron job/);
	});

	it("updates fields and reparses schedules", async () => {
		const job = await createJob({ prompt: "old", schedule: "every 1h" });
		const updated = await updateJob(job.id, { prompt: "new", schedule: "*/10 * * * *" });
		expect(updated.prompt).toBe("new");
		expect(updated.schedule).toEqual({ kind: "cron", expr: "*/10 * * * *" });
		expect(updated.nextRunAt).not.toBeNull();
	});

	it("pauses, resumes, and removes jobs", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 1h" });
		expect((await pauseJob(job.id)).state).toBe("paused");
		const resumed = await resumeJob(job.id);
		expect(resumed.state).toBe("scheduled");
		expect(resumed.nextRunAt).not.toBeNull();
		await removeJob(job.id);
		expect(listJobs()).toHaveLength(0);
	});

	it("persists atomically and round-trips through a reload", async () => {
		const job = await createJob({ prompt: "persist me", schedule: "every 2h" });
		// Force a cold reload from disk.
		setCronBaseDir(undefined);
		setCronBaseDir(dir);
		expect(getJob(job.id).prompt).toBe("persist me");
		const raw = JSON.parse(readFileSync(join(dir, "cron", "jobs.json"), "utf-8"));
		expect(Array.isArray(raw.jobs)).toBe(true);
		expect(raw.jobs).toHaveLength(1);
		expect(typeof raw.updated_at).toBe("string");
		// No tmp files left behind by the atomic write.
		expect(readdirSync(join(dir, "cron")).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
	});
});

describe("getDueJobs", () => {
	it("skips disabled, paused, and completed jobs", async () => {
		const a = await createJob({ prompt: "a", schedule: "every 1h" });
		const b = await createJob({ prompt: "b", schedule: "every 1h" });
		const c = await createJob({ prompt: "c", schedule: "every 1h" });
		const past = new Date(Date.now() - 60_000).toISOString();
		await updateJob(a.id, { nextRunAt: past });
		await updateJob(b.id, { nextRunAt: past });
		await updateJob(c.id, { nextRunAt: past });
		await updateJob(a.id, { enabled: false });
		await pauseJob(b.id);
		const due = await getDueJobs();
		expect(due.map((j) => j.id)).toEqual([c.id]);
	});

	it("collapses a recurring backlog: fires once and fast-forwards nextRunAt", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m" });
		// 3 hours overdue; grace for a 30m period is max(15m, 120s) = 15m.
		await updateJob(job.id, { nextRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
		const before = Date.now();
		const due = await getDueJobs();
		expect(due.map((j) => j.id)).toEqual([job.id]);
		const after = getJob(job.id);
		expect(after.nextRunAt).not.toBeNull();
		expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(before);
	});

	it("one-shots recover within 120s and error beyond it", async () => {
		const oneShot = await createJob({ prompt: "o", schedule: "2030-01-01T00:00:00.000Z" });
		await updateJob(oneShot.id, { nextRunAt: new Date(Date.now() - 100_000).toISOString() });
		const missed = await createJob({ prompt: "m", schedule: "2030-01-01T00:00:00.000Z" });
		await updateJob(missed.id, { nextRunAt: new Date(Date.now() - 200_000).toISOString() });

		const due = await getDueJobs();
		expect(due.map((j) => j.id)).toEqual([oneShot.id]);
		const missedAfter = getJob(missed.id);
		expect(missedAfter.state).toBe("error");
		expect(missedAfter.nextRunAt).toBeNull();
		expect(missedAfter.lastError).toContain("120s");
	});
});

describe("advanceNextRun / markJobRun", () => {
	it("advanceNextRun moves a recurring job to the next future slot", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m" });
		await updateJob(job.id, { nextRunAt: new Date(Date.now() - 5 * 60_000).toISOString() });
		const advanced = await advanceNextRun(job.id);
		expect(new Date(advanced.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
		// Interval anchor is preserved (multiples of 30m from the original slot).
		const original = new Date(job.nextRunAt!).getTime();
		expect((new Date(advanced.nextRunAt!).getTime() - original) % (30 * 60_000)).toBe(0);
	});

	it("markJobRun completes finite repeats and re-anchors recurring jobs", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 30m", times: 2 });
		const first = await markJobRun(job.id, { status: "ok" });
		expect(first.repeat.completed).toBe(1);
		expect(first.state).toBe("scheduled");
		expect(new Date(first.nextRunAt!).getTime()).toBeGreaterThanOrEqual(new Date(first.lastRunAt!).getTime());
		const second = await markJobRun(job.id, { status: "error", error: "boom" });
		expect(second.repeat.completed).toBe(2);
		expect(second.state).toBe("completed");
		expect(second.nextRunAt).toBeNull();
		expect(second.lastStatus).toBe("error");
		expect(second.lastError).toBe("boom");
	});

	it("markJobRun completes one-shots after a single run", async () => {
		const job = await createJob({ prompt: "o", schedule: "30m" });
		const marked = await markJobRun(job.id, { status: "ok" });
		expect(marked.state).toBe("completed");
		expect(marked.nextRunAt).toBeNull();
	});
});

describe("job output", () => {
	it("saves and reads back the latest output", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 1h" });
		expect(getLatestJobOutput(job.id)).toBeNull();
		await saveJobOutput(job.id, "first");
		await saveJobOutput(job.id, "second");
		expect(getLatestJobOutput(job.id)).toBe("second");
	});

	it("caps retention at the newest 50 files", async () => {
		const job = await createJob({ prompt: "p", schedule: "every 1h" });
		for (let i = 1; i <= 55; i++) {
			await saveJobOutput(job.id, `run ${i}`);
		}
		const files = readdirSync(join(dir, "cron", "output", job.id));
		expect(files).toHaveLength(OUTPUT_RETENTION);
		expect(getLatestJobOutput(job.id)).toBe("run 55");
		// Oldest surviving file is run 6 (55 - 50 + 1).
		const contents = files.sort().map((f) => readFileSync(join(dir, "cron", "output", job.id, f), "utf-8"));
		expect(contents[0]).toBe("run 6");
	});
});
