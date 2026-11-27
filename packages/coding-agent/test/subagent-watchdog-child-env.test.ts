import { afterEach, expect, it, vi } from "vitest";
import { buildPiArgs, cleanupTempDir } from "../src/builtin-extensions/pi-subagents/src/runs/shared/pi-args.ts";
import {
	CHILD_WATCHDOG_CONFIG_ENV,
	decodeChildWatchdogConfig,
} from "../src/builtin-extensions/pi-subagents/src/watchdog/child-status.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

// A child that runs with a watchdog config spawns a grandchild that has none of its own.
it("does not pass a child's watchdog config on to a grandchild without one", () => {
	vi.stubEnv(
		CHILD_WATCHDOG_CONFIG_ENV,
		JSON.stringify({ enabled: true, runId: "run", agent: "run-0", childIndex: 0 }),
	);
	const { env, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "complete the task",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: false,
		runId: "grandchild-run",
		childId: "grandchild",
	});
	try {
		const spawnEnv = { ...process.env, ...env };
		expect(decodeChildWatchdogConfig(spawnEnv[CHILD_WATCHDOG_CONFIG_ENV])).toBeUndefined();
	} finally {
		cleanupTempDir(tempDir);
	}
});
