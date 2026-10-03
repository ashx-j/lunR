import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	acquireSchedulerLease,
	claimJobRun,
	createJob,
	getJob,
	listJobs,
	removeJob,
	resumeJob,
	setCronBaseDir,
	updateJob,
} from "../src/core/cron/jobs.ts";
import { CronAdmissionDeferred, runSchedulerTick, startScheduler } from "../src/core/cron/scheduler.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-cron-owner-"));
	setCronBaseDir(dir);
});
afterEach(() => {
	setCronBaseDir(undefined);
	rmSync(dir, { recursive: true, force: true });
});

function worker(action: string, argument = "") {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/^PI_(SUBAGENT|SUBAGENTS|INTERCOM)_/.test(key)),
	);
	env.PI_CODING_AGENT_DIR = dir;
	return new Promise<string>((res, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(new URL("./fixtures/cron-worker.ts", import.meta.url)),
				dir,
				action,
				argument,
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let out = "";
		let error = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			error += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? res(out) : reject(new Error(error || `worker exit ${code}`))));
	});
}

it("two processes cannot dispatch the same one-shot occurrence", async () => {
	const job = await createJob({ prompt: "fake", schedule: "30m" });
	await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	await Promise.all([worker("tick"), worker("tick")]);
	expect(readFileSync(join(dir, "runs.txt"), "utf8").trim().split("\n")).toEqual([job.id]);
	expect(getJob(job.id).repeat.completed).toBe(1);
});

it("fresh locked mutations retain concurrent creations and edits", async () => {
	expect(listJobs()).toEqual([]);
	const job = await createJob({ prompt: "existing", schedule: "every 30m" });
	await Promise.all([worker("create", "a"), worker("create", "b"), worker("edit", job.id)]);
	expect(listJobs()).toHaveLength(17);
	expect(getJob(job.id).name).toBe("renamed-7");
});

it("external pause and deletion invalidate a previously collected occurrence", async () => {
	const job = await createJob({ prompt: "fake", schedule: "30m" });
	await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	await worker("pause", job.id);
	await worker("tick");
	expect(existsSync(join(dir, "runs.txt"))).toBe(false);
	await worker("remove", job.id);
	expect(await claimJobRun(job.id, new Date())).toBeNull();
});

it("an interrupted started occurrence pauses instead of replaying", async () => {
	const job = await createJob({ prompt: "fake", schedule: "30m" });
	await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	await claimJobRun(job.id, new Date());
	await worker("tick");
	expect(getJob(job.id).state).toBe("paused");
	expect(getJob(job.id).lastError).toContain("unknown effects");
	await expect(resumeJob(job.id)).rejects.toThrow("deliberate retry");
	expect(existsSync(join(dir, "runs.txt"))).toBe(false);
});

it("busy admission leaves the occurrence due without counting or delivering it", async () => {
	const job = await createJob({ prompt: "fake", schedule: "30m" });
	const slot = new Date().toISOString();
	await updateJob(job.id, { nextRunAt: slot });
	await runSchedulerTick({
		runJob: async () => {
			throw new CronAdmissionDeferred("busy");
		},
		deliverResult: async () => {
			throw new Error("must not deliver");
		},
	});
	expect(getJob(job.id).nextRunAt).toBe(slot);
	expect(getJob(job.id).repeat.completed).toBe(0);
	expect(getJob(job.id).activeRun).toBeUndefined();
});

it("stop cancels and settles the first job, skips later due jobs and releases ownership last", async () => {
	const first = await createJob({ prompt: "first", schedule: "30m" });
	const second = await createJob({ prompt: "second", schedule: "30m" });
	for (const job of [first, second]) await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	let began!: () => void;
	const started = new Promise<void>((resolve) => {
		began = resolve;
	});
	let cancel!: () => void;
	const cancelled = new Promise<void>((resolve) => {
		cancel = resolve;
	});
	let finish!: () => void;
	const runs: string[] = [];
	const scheduler = startScheduler({
		intervalMs: 10,
		runJob: async (_prompt, job, signal) => {
			runs.push(job.id);
			signal.addEventListener("abort", cancel, { once: true });
			began();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return "late";
		},
		deliverResult: async () => {},
	});
	await started;
	let stopped = false;
	const stop = scheduler.stop().then(() => {
		stopped = true;
	});
	await cancelled;
	expect(stopped).toBe(false);
	expect(await acquireSchedulerLease()).toBeNull();
	finish();
	await stop;
	expect(runs).toEqual([first.id]);
	expect(getJob(first.id).lastStatus).toBe("error");
	expect(getJob(second.id).repeat.completed).toBe(0);
	const release = await acquireSchedulerLease();
	expect(release).not.toBeNull();
	await release!();
});

it("an initially empty owner sees later external jobs and rejects another operator's manual run", async () => {
	const scheduler = startScheduler({ intervalMs: 10, runJob: async () => "ok", deliverResult: async () => {} });
	const other = startScheduler({ intervalMs: 60_000, runJob: async () => "bad", deliverResult: async () => {} });
	try {
		await worker("create", "later");
		const job = listJobs()[0];
		await expect(other.run(job.id)).rejects.toThrow("another process owns");
		await updateJob(job.id, { nextRunAt: new Date().toISOString() });
		const deadline = Date.now() + 2000;
		while (getJob(job.id).repeat.completed === 0 && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(getJob(job.id).repeat.completed).toBe(1);
	} finally {
		await other.stop();
		await scheduler.stop();
	}
});

it("removal during execution stays removed", async () => {
	const job = await createJob({ prompt: "fake", schedule: "30m" });
	await updateJob(job.id, { nextRunAt: new Date().toISOString() });
	await runSchedulerTick({
		runJob: async () => {
			await removeJob(job.id);
			return "ok";
		},
		deliverResult: async () => {},
	});
	expect(listJobs()).toEqual([]);
});

it("never steals an expired lease from a live operator", async () => {
	const release = await acquireSchedulerLease();
	const old = new Date(Date.now() - 600_000);
	utimesSync(join(dir, "cron", "scheduler.lock"), old, old);
	try {
		await worker("tick");
		expect(existsSync(join(dir, "runs.txt"))).toBe(false);
	} finally {
		await release!();
	}
});

it("releases an acquired lease if writing owner metadata fails", async () => {
	const owner = join(dir, "cron", "scheduler.owner.json");
	mkdirSync(owner, { recursive: true });
	await expect(acquireSchedulerLease()).rejects.toThrow();
	expect(existsSync(join(dir, "cron", "scheduler.lock"))).toBe(false);
	expect(readdirSync(join(dir, "cron"))).toEqual(["scheduler.owner.json"]);
	rmSync(owner, { recursive: true });
	const release = await acquireSchedulerLease();
	expect(release).not.toBeNull();
	await release!();
});

it("attempts lease release even when metadata removal fails", async () => {
	const release = await acquireSchedulerLease();
	const owner = join(dir, "cron", "scheduler.owner.json");
	rmSync(owner);
	mkdirSync(owner);
	await expect(release!()).rejects.toThrow();
	expect(existsSync(join(dir, "cron", "scheduler.lock"))).toBe(false);
});

function expiredLease() {
	const old = new Date(Date.now() - 600_000);
	utimesSync(join(dir, "cron", "scheduler.lock"), old, old);
}

async function crashOwner(stage: string): Promise<number> {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !/^PI_(SUBAGENT|SUBAGENTS|INTERCOM)_/.test(key)),
	);
	env.PI_CODING_AGENT_DIR = dir;
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				fileURLToPath(new URL("./fixtures/cron-owner-crash.ts", import.meta.url)),
				dir,
				stage,
			],
			{ env, stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (_code, signal) => {
			if (signal !== "SIGKILL" || !child.pid)
				reject(new Error(stderr || "fixture did not crash at the owner boundary"));
			else resolve(child.pid);
		});
	});
}

it.each(["write", "publish"])("recovers after an owner crashes during atomic metadata %s", async (stage) => {
	const previousPid = await crashOwner("published");
	const owner = join(dir, "cron", "scheduler.owner.json");
	expect(JSON.parse(readFileSync(owner, "utf8"))).toEqual({ pid: previousPid });
	expiredLease();
	await crashOwner(stage);
	expect(JSON.parse(readFileSync(owner, "utf8"))).toEqual({ pid: previousPid });
	expiredLease();
	const release = await acquireSchedulerLease();
	expect(release).not.toBeNull();
	await release!();
});

it.each(["", '{"pid":', "{}", '{"pid":0}', '{"pid":-1}', '{"pid":1.5}'])(
	"preserves unknown scheduler ownership and explains safe repair for %j",
	async (metadata) => {
		mkdirSync(join(dir, "cron", "scheduler.lock"), { recursive: true });
		const owner = join(dir, "cron", "scheduler.owner.json");
		writeFileSync(owner, metadata);
		expiredLease();
		await expect(acquireSchedulerLease()).rejects.toThrow("confirm every operator using this profile has stopped");
		expect(readFileSync(owner, "utf8")).toBe(metadata);
		expect(existsSync(join(dir, "cron", "scheduler.lock"))).toBe(true);
		// This fixture has no live operator; simulate the instructed deliberate repair.
		rmSync(join(dir, "cron", "scheduler.lock"), { recursive: true });
		rmSync(owner);
		const release = await acquireSchedulerLease();
		expect(release).not.toBeNull();
		await release!();
	},
);

it("keeps an expired ownerless lease closed until deliberate repair", async () => {
	await crashOwner("write");
	expect(existsSync(join(dir, "cron", "scheduler.owner.json"))).toBe(false);
	expiredLease();
	await expect(acquireSchedulerLease()).rejects.toThrow("confirm every operator using this profile has stopped");
	expect(existsSync(join(dir, "cron", "scheduler.lock"))).toBe(true);
});

it("retries when a competing operator releases its lease before the metadata check stats it", async () => {
	expect(await worker("lease-release-stat-race")).toBe("reacquired");
	expect(existsSync(join(dir, "cron", "scheduler.lock"))).toBe(false);
});

it("manual runs report a pre-dispatch deferral instead of claiming completion", async () => {
	const job = await createJob({ prompt: "saved project task", schedule: "30m" });
	const scheduler = startScheduler({
		runJob: async () => {
			throw new CronAdmissionDeferred("saved project does not match");
		},
		deliverResult: async () => {
			throw new Error("must not deliver");
		},
	});
	try {
		await expect(scheduler.run(job.id)).rejects.toThrow("Cron job was not admitted: saved project does not match");
		expect(getJob(job.id).repeat.completed).toBe(0);
		expect(getJob(job.id).nextRunAt).toBe(job.nextRunAt);
		expect(getJob(job.id).activeRun).toBeUndefined();
	} finally {
		await scheduler.stop();
	}
});
