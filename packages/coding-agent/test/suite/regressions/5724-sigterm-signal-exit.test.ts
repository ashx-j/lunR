import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionExit, type SessionExitHost } from "../../../src/modes/interactive/session-exit.ts";

// Regression for https://github.com/earendil-works/pi/issues/5724
//
// `proper-lockfile` installs `signal-exit`, whose signal listener re-sends
// SIGTERM/SIGHUP when it observes no other process listeners during the same
// signal dispatch. InteractiveMode must therefore keep its signal handlers
// registered until async terminal cleanup has completed.

type ShutdownThis = {
	stopPlanUsagePolling: () => void;
	stopSmoothStreaming: () => void;
	session: { stopAdmission: () => void };
	runtimeHost: { dispose: () => Promise<void> };
	ui: { terminal: { drainInput: (ms: number) => Promise<void> } };
	themeController: { disableAutoSync: () => void };
	stop: () => void;
};

class ProcessExitError extends Error {}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return {
		promise,
		resolve: () => resolve?.(),
	};
}

async function callShutdown(exit: SessionExit, options?: { fromSignal?: boolean }): Promise<void> {
	try {
		await exit.shutdown(options);
	} catch (error) {
		if (!(error instanceof ProcessExitError)) throw error;
	}
}

describe("SessionExit SIGTERM shutdown with signal-exit (#5724)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("keeps signal handlers registered while signal-triggered cleanup is pending", async () => {
		vi.spyOn(process, "exit").mockImplementation((() => {
			throw new ProcessExitError();
		}) as typeof process.exit);

		const order: string[] = [];
		const dispose = deferred();
		const disposeStarted = deferred();
		const context: ShutdownThis = {
			stopPlanUsagePolling: vi.fn(),
			stopSmoothStreaming: vi.fn(() => {
				order.push("stopSmoothStreaming");
			}),
			session: { stopAdmission: vi.fn(() => order.push("stopAdmission")) },
			runtimeHost: {
				dispose: vi.fn(() => {
					order.push("dispose");
					disposeStarted.resolve();
					return dispose.promise;
				}),
			},
			ui: {
				terminal: {
					drainInput: vi.fn(async () => {
						order.push("drainInput");
					}),
				},
			},
			themeController: { disableAutoSync: vi.fn() },
			stop: vi.fn(() => {
				order.push("stop");
			}),
		};

		const exit = new SessionExit(context as unknown as SessionExitHost);
		const unregister = vi.spyOn(exit, "unregisterSignalHandlers").mockImplementation(() => {
			order.push("unregister");
		});
		const shutdownPromise = callShutdown(exit, { fromSignal: true });
		await disposeStarted.promise;

		expect(order).toEqual(["stopAdmission", "stopSmoothStreaming", "dispose"]);
		expect(unregister).not.toHaveBeenCalled();

		dispose.resolve();
		await shutdownPromise;

		expect(order).toEqual(["stopAdmission", "stopSmoothStreaming", "dispose", "drainInput", "stop"]);
		expect(unregister).not.toHaveBeenCalled();
	});
});
