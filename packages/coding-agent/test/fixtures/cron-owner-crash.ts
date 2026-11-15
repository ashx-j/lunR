import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { acquireSchedulerLease, setCronBaseDir } from "../../src/core/cron/jobs.ts";

const [dir, stage] = process.argv.slice(2);
setCronBaseDir(dir);
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
if (stage === "write") {
	fs.writeFileSync = ((file, ...args) => {
		if (basename(String(file)).includes("scheduler.owner.json")) {
			fs.openSync(file, "w");
			process.kill(process.pid, "SIGKILL");
			throw new Error("SIGKILL returned unexpectedly");
		}
		return originalWrite(file, ...args);
	}) as typeof fs.writeFileSync;
} else if (stage === "publish") {
	fs.renameSync = (from, to) => {
		if (basename(String(to)) === "scheduler.owner.json") {
			process.kill(process.pid, "SIGKILL");
			throw new Error("SIGKILL returned unexpectedly");
		}
		return originalRename(from, to);
	};
}
syncBuiltinESMExports();
const release = await acquireSchedulerLease();
if (!release) throw new Error("fixture failed to acquire the scheduler");
process.kill(process.pid, "SIGKILL");
