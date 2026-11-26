import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { acquireSchedulerLease, setCronBaseDir } from "../../src/core/cron/jobs.ts";

const [dir, stage] = process.argv.slice(2);
// Windows reports a self-SIGKILL as a plain non-zero exit, so the test also looks for this marker.
function crash(): never {
	fs.writeSync(2, "CRASH_AT_OWNER_BOUNDARY\n");
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL returned unexpectedly");
}
setCronBaseDir(dir);
const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
if (stage === "write") {
	fs.writeFileSync = ((file, ...args) => {
		if (basename(String(file)).includes("scheduler.owner.json")) {
			fs.openSync(file, "w");
			crash();
		}
		return originalWrite(file, ...args);
	}) as typeof fs.writeFileSync;
} else if (stage === "publish") {
	fs.renameSync = (from, to) => {
		if (basename(String(to)) === "scheduler.owner.json") {
			crash();
		}
		return originalRename(from, to);
	};
}
syncBuiltinESMExports();
const release = await acquireSchedulerLease();
if (!release) throw new Error("fixture failed to acquire the scheduler");
crash();
