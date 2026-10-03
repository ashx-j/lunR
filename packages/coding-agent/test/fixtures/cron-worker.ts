import { appendFileSync } from "node:fs";
import {
	createJob,
	getJob,
	listJobs,
	pauseJob,
	removeJob,
	setCronBaseDir,
	updateJob,
} from "../../src/core/cron/jobs.ts";
import { runSchedulerTick } from "../../src/core/cron/scheduler.ts";

const [dir, action, argument] = process.argv.slice(2);
setCronBaseDir(dir);
if (action === "create") {
	for (let i = 0; i < 8; i++) await createJob({ prompt: `${argument}-${i}`, schedule: "every 30m" });
} else if (action === "edit") {
	for (let i = 0; i < 8; i++) await updateJob(argument, { name: `renamed-${i}` });
} else if (action === "pause") {
	await pauseJob(argument);
} else if (action === "remove") {
	await removeJob(argument);
} else if (action === "tick") {
	await runSchedulerTick({
		runJob: async (_prompt, job) => {
			if (!getJob(job.id).activeRun) throw new Error("missing durable claim");
			appendFileSync(`${dir}/runs.txt`, `${job.id}\n`);
			await new Promise((resolve) => setTimeout(resolve, 200));
			return "fixture result";
		},
		deliverResult: async () => {},
	});
} else if (action === "list") {
	process.stdout.write(JSON.stringify(listJobs()));
}
