import { afterEach, expect, it, vi } from "vitest";
import {
	CHILD_WATCHDOG_STATUS_EVENT,
	encodeChildWatchdogConfig,
	resolveChildWatchdogConfig,
} from "../src/builtin-extensions/pi-subagents/src/watchdog/child-status.ts";
import { registerChildWatchdog } from "../src/builtin-extensions/pi-subagents/src/watchdog/register-child.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../src/builtin-extensions/pi-subagents/src/watchdog/settings.ts";
import { restoreStdout, takeOverStdout } from "../src/core/output-guard.ts";

afterEach(() => {
	restoreStdout();
	vi.restoreAllMocks();
});

// A lunR child in json mode runs with takeOverStdout(), and the parent reads watchdog events from stdout only.
it("writes child watchdog status to raw stdout while stdout is taken over", async () => {
	const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, callback) => {
		if (typeof callback === "function") callback();
		return true;
	});
	const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	takeOverStdout();
	const handlers = new Map<string, () => unknown>();
	const pi = {
		on: (name: string, handler: () => unknown) => handlers.set(name, handler),
		sendMessage: vi.fn(),
		getThinkingLevel: () => "off",
	};
	const config = resolveChildWatchdogConfig({
		config: {
			...DEFAULT_WATCHDOG_CONFIG,
			enabled: true,
			children: { ...DEFAULT_WATCHDOG_CONFIG.children, enabled: true },
		},
		agent: "run-0",
		runId: "run",
		childIndex: 0,
	});
	registerChildWatchdog(pi as never, encodeChildWatchdogConfig(config));
	handlers.get("session_shutdown")?.();
	await vi.waitFor(() =>
		expect(stdoutWrite.mock.calls.some(([chunk]) => String(chunk).includes(CHILD_WATCHDOG_STATUS_EVENT))).toBe(true),
	);
	expect(stderrWrite.mock.calls.some(([chunk]) => String(chunk).includes(CHILD_WATCHDOG_STATUS_EVENT))).toBe(false);
});
