import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { normalizeChildSpec } from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { CHILD_WATCHDOG_STATUS_EVENT } from "../src/builtin-extensions/pi-subagents/src/watchdog/child-status.ts";
import { resetPermissions } from "../src/core/permissions.ts";

const fixture = vi.hoisted(() => ({ command: vi.fn(), child: undefined as ChildProcess | undefined }));
vi.mock("../src/builtin-extensions/pi-subagents/src/runs/shared/pi-spawn.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/builtin-extensions/pi-subagents/src/runs/shared/pi-spawn.ts")>()),
	getPiSpawnCommand: fixture.command,
}));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			fixture.child = actual.spawn(...args);
			return fixture.child;
		},
	};
});

let root: string | undefined;
afterEach(async () => {
	const child = fixture.child;
	if (child && child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
	}
	fixture.child = undefined;
	resetPermissions();
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
});

// The child ends its turn, reports a watchdog review that outlasts the parent's 1 s
// post-turn grace, then reports idle and exits by itself.
it.skipIf(process.platform === "win32")("waits for the child's watchdog review before stopping the child", async () => {
	root = mkdtempSync(join(tmpdir(), "lunr-child-watchdog-"));
	for (const key of Object.keys(process.env)) {
		if (/^PI_(SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(key)) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("PI_CODING_AGENT_DIR", root);
	writeFileSync(
		join(root, "settings.json"),
		JSON.stringify({ subagents: { watchdog: { enabled: true, children: { enabled: true } } } }),
	);
	resetPermissions("auto");
	const runId = "watchdog-run";
	const spec = normalizeChildSpec(
		{ task: "Check scratch.", description: "Scratch child", permissions: "read-only", model: "test/model" },
		{ runId, index: 0, parentMode: "auto" },
	);
	const reviewed = join(root, "reviewed");
	const status = (seq: number, phase: string) =>
		JSON.stringify({
			type: CHILD_WATCHDOG_STATUS_EVENT,
			runId,
			agent: spec.childId,
			childIndex: 0,
			seq,
			phase,
			ts: Date.now(),
			followUpPending: false,
		});
	const turnEnd = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
	});
	fixture.command.mockReturnValue({
		command: process.execPath,
		args: [
			"-e",
			`
		console.log(${JSON.stringify(turnEnd)});
		console.log(${JSON.stringify(status(1, "reviewing"))});
		setTimeout(() => {
			console.log(${JSON.stringify(status(2, "idle"))});
			require('node:fs').writeFileSync(${JSON.stringify(reviewed)}, 'reviewed');
			process.exit(0);
		}, 1800);
	`,
		],
	});
	const result = await runSync(root, spec, {
		runId,
		index: 0,
		cwd: root,
		communicationEnabled: false,
		artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
		acceptance: false,
	});
	expect(existsSync(reviewed)).toBe(true);
	expect(fixture.child?.signalCode).toBeNull();
	expect(result.watchdog?.phase).toBe("idle");
});
