import { beforeEach, describe, expect, it, vi } from "vitest";

const { computeWatchdogRepoChangeSignature } = vi.hoisted(() => ({
	computeWatchdogRepoChangeSignature: vi.fn(),
}));

vi.mock("../src/builtin-extensions/pi-subagents/src/watchdog/change-signature.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/builtin-extensions/pi-subagents/src/watchdog/change-signature.ts")
	>()),
	computeWatchdogRepoChangeSignature,
}));

import type { WatchdogRepoChangeSignature } from "../src/builtin-extensions/pi-subagents/src/watchdog/change-signature.ts";
import { MainWatchdogRuntime } from "../src/builtin-extensions/pi-subagents/src/watchdog/runtime.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../src/builtin-extensions/pi-subagents/src/watchdog/settings.ts";
import type { WatchdogSettingsResult } from "../src/builtin-extensions/pi-subagents/src/watchdog/types.ts";

function settings(mainEnabled: boolean, globalEnabled = mainEnabled): WatchdogSettingsResult {
	return {
		ok: true,
		config: {
			...DEFAULT_WATCHDOG_CONFIG,
			enabled: globalEnabled,
			main: { ...DEFAULT_WATCHDOG_CONFIG.main, enabled: mainEnabled },
			lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp, enabled: false },
		},
		errors: [],
		sources: [],
	};
}

function repoSignature(
	cwd: string,
	key: string,
	changedPaths = ["src/existing-change.ts"],
): WatchdogRepoChangeSignature {
	return { root: cwd, key, changedPaths };
}

describe("subagent watchdog startup", () => {
	beforeEach(() => {
		computeWatchdogRepoChangeSignature.mockReset();
	});

	it("does no repository signature work while the watchdog is disabled", async () => {
		const cwd = "C:/repo";
		computeWatchdogRepoChangeSignature.mockReturnValue(repoSignature(cwd, "initial"));
		const review = vi.fn();
		const runtime = new MainWatchdogRuntime({
			cwd,
			resolveConfig: () => settings(false, true),
			review,
			reviewChangesOnly: true,
		});

		runtime.bindSession({ cwd });
		runtime.handleBeforeAgentStart({ prompt: "inspect only" }, { cwd });
		runtime.enqueueDelta("No enabled watchdog work should be queued.");
		await runtime.handleAgentEnd({}, { cwd });

		expect(computeWatchdogRepoChangeSignature).not.toHaveBeenCalled();
		expect(review).not.toHaveBeenCalled();
	});

	it("lazily baselines enabled sessions once per turn and reviews only later changes", async () => {
		const firstCwd = "C:/repo-a";
		const secondCwd = "C:/repo-b";
		let current = repoSignature(firstCwd, "repo-a:existing");
		computeWatchdogRepoChangeSignature.mockImplementation((cwd: string) => ({ ...current, root: cwd }));
		const review = vi.fn(() => ({ warnings: [] }));
		const runtime = new MainWatchdogRuntime({
			cwd: firstCwd,
			resolveConfig: () => settings(true),
			review,
			reviewChangesOnly: true,
		});

		expect(computeWatchdogRepoChangeSignature).not.toHaveBeenCalled();
		runtime.bindSession({ cwd: firstCwd });
		expect(computeWatchdogRepoChangeSignature).not.toHaveBeenCalled();

		runtime.handleBeforeAgentStart({ prompt: "first turn" }, { cwd: firstCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(1);
		runtime.enqueueDelta("The repo was already dirty before this turn.");
		await runtime.handleAgentEnd({}, { cwd: firstCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(2);
		expect(review).not.toHaveBeenCalled();

		runtime.handleBeforeAgentStart({ prompt: "second turn" }, { cwd: firstCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(3);
		current = repoSignature(firstCwd, "repo-a:edited", ["src/edited-this-turn.ts"]);
		runtime.enqueueDelta("Edited src/edited-this-turn.ts.");
		await runtime.handleAgentEnd({}, { cwd: firstCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(4);
		expect(review).toHaveBeenCalledOnce();

		current = repoSignature(secondCwd, "repo-b:existing", ["src/preexisting-in-new-session.ts"]);
		runtime.bindSession({ cwd: secondCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(4);
		runtime.handleBeforeAgentStart({ prompt: "new session" }, { cwd: secondCwd });
		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(5);
		runtime.enqueueDelta("The new session also started dirty.");
		await runtime.handleAgentEnd({}, { cwd: secondCwd });

		expect(computeWatchdogRepoChangeSignature).toHaveBeenCalledTimes(6);
		expect(review).toHaveBeenCalledOnce();
	});
});
