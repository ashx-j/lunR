import { describe, expect, it } from "vitest";
import { parseStartupMilestones, parseStartupTimings } from "../../../scripts/profile-coding-agent-node.mjs";
import { InteractiveStartupShell } from "../src/startup/interactive-shell.ts";
import { resolvePreloadLaunchMode } from "../src/startup/launch-routing.ts";

describe("instant launch routing", () => {
	const terminal = { stdinIsTTY: true, stdoutIsTTY: true, startupBenchmark: false };

	it("starts the shell only for interactive launches", () => {
		expect(resolvePreloadLaunchMode([], terminal)).toBe("interactive");
		expect(resolvePreloadLaunchMode(["--print"], terminal)).toBe("deferred");
		expect(resolvePreloadLaunchMode(["--mode", "rpc"], terminal)).toBe("deferred");
		expect(resolvePreloadLaunchMode(["gateway"], terminal)).toBe("deferred");
		expect(resolvePreloadLaunchMode([], { ...terminal, stdinIsTTY: false })).toBe("deferred");
	});
});

describe("startup shell handoff", () => {
	it("keeps the editor draft and queued submission in the canonical editor", () => {
		const shell = new InteractiveStartupShell();
		shell.editor.onSubmit?.(" queued prompt ");
		shell.editor.setText("next draft");

		const binding = shell.binding();
		expect(binding.editor).toBe(shell.editor);
		expect(binding.editor.getText()).toBe("next draft");
		expect(binding.pendingSubmissions).toEqual([{ text: " queued prompt ", attachments: [] }]);
	});

	it("records exit requests while runtime hydration is still pending", () => {
		const shell = new InteractiveStartupShell();
		shell.stop();
		expect(shell.isExitRequested).toBe(true);
	});

	it("resolves first-frame readiness even when the status line wraps", async () => {
		const originalColumns = process.stdout.columns;
		Object.defineProperty(process.stdout, "columns", { configurable: true, value: 8 });
		const shell = new InteractiveStartupShell();
		try {
			const firstFrame = shell.waitForFirstFrame();
			shell.start();
			await expect(firstFrame).resolves.toBeUndefined();
		} finally {
			shell.stop();
			Object.defineProperty(process.stdout, "columns", { configurable: true, value: originalColumns });
		}
	});
});

describe("startup benchmark parsing", () => {
	it("parses namespaced timing blocks and machine-readable milestones", () => {
		const stderr = [
			"--- Startup Timings: main ---",
			"  import:main: 123.5ms",
			"  TOTAL: 123.5ms",
			"-----------------------------",
			'LUNR_STARTUP_MILESTONE {"name":"input_handler_armed","ms":42.25}',
			'LUNR_STARTUP_MILESTONE {"name":"prompt_barrier_open","ms":456.75}',
			'LUNR_STARTUP_MILESTONE {"name":"first_provider_request_started","ms":500}',
		].join("\n");

		expect(Object.fromEntries(parseStartupTimings(stderr))).toEqual({ "import:main": 123.5 });
		expect(Object.fromEntries(parseStartupMilestones(stderr))).toEqual({
			input_handler_armed: 42.25,
			prompt_barrier_open: 456.75,
			first_provider_request_started: 500,
		});
	});
});
