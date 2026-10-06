import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PR_WATCH_DEFAULT_DURATION_MS, validPrWatchDuration } from "./types.ts";

export function readPrWatchDuration(agentDir: string): number {
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		if (
			value &&
			typeof value === "object" &&
			"prWatchDurationMs" in value &&
			validPrWatchDuration(value.prWatchDurationMs)
		)
			return value.prWatchDurationMs;
	} catch {}
	return PR_WATCH_DEFAULT_DURATION_MS;
}
