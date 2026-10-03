import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { normalizeChildSpec } from "../src/builtin-extensions/pi-subagents/src/shared/child-spec.ts";
import { DEFAULT_ARTIFACT_CONFIG } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
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

it.skipIf(process.platform === "win32")(
	"settles a real POSIX child that ignores SIGTERM after bounded hard termination",
	async () => {
		root = mkdtempSync(join(tmpdir(), "lunr-noncooperative-child-"));
		for (const key of Object.keys(process.env)) {
			if (/^PI_(SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(key)) vi.stubEnv(key, undefined);
		}
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		resetPermissions("auto");
		const ready = join(root, "ready");
		fixture.command.mockReturnValue({
			command: process.execPath,
			args: [
				"-e",
				`
		process.on('SIGTERM', () => {});
		require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
		setInterval(() => {}, 1000);
	`,
			],
		});
		const controller = new AbortController();
		const result = runSync(
			root,
			normalizeChildSpec(
				{ task: "Read scratch.", description: "Scratch child", permissions: "read-only", model: "test/model" },
				{ runId: "posix-cancel", index: 0, parentMode: "auto" },
			),
			{
				runId: "posix-cancel",
				cwd: root,
				signal: controller.signal,
				communicationEnabled: false,
				artifactConfig: { ...DEFAULT_ARTIFACT_CONFIG, enabled: false },
				acceptance: false,
			},
		);
		await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000, interval: 20 });
		controller.abort();
		let settled = false;
		void result.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5000, interval: 20 });
		expect((await result).exitCode).not.toBe(0);
		expect(fixture.child?.signalCode).toBe("SIGKILL");
	},
);
