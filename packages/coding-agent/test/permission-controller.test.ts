import { describe, expect, it, vi } from "vitest";

const pickerNotes = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock("../src/modes/interactive/components/model-selector.ts", () => ({
	ModelSelectorComponent: class {
		constructor(...args: unknown[]) {
			pickerNotes.push((args[8] as { note?: string } | undefined)?.note);
		}
	},
}));

import {
	type PermissionControllerHost,
	PermissionModeController,
} from "../src/modes/interactive/permission-controller.ts";

function createController(defaultMode: "yolo" | "read-only") {
	const session = {
		permissionMode: "read-only" as const,
		settingsManager: { getDefaultPermissionMode: () => defaultMode },
		setPermissionMode: vi.fn(),
	};
	const host = { session, showStatus: vi.fn(), isSessionDetached: () => false, recordActivity: vi.fn() };
	return { controller: new PermissionModeController(host as unknown as PermissionControllerHost), host, session };
}

describe("PermissionModeController /plan off", () => {
	it("explains that there is nothing to restore when read is the saved default", async () => {
		const { controller, host, session } = createController("read-only");
		await controller.handlePlanCommand("off");
		expect(session.setPermissionMode).not.toHaveBeenCalled();
		expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining("/mode yolo"));
	});
});

describe("PermissionModeController review model picker", () => {
	it("names no provider before any model is selected", () => {
		const session = {
			model: undefined,
			settingsManager: { getAutoReviewModel: () => undefined },
			modelRuntime: {},
			scopedModels: [],
		};
		const host = {
			session,
			ui: {},
			showSelector: (create: (done: () => void) => unknown) => create(() => {}),
			resolveModelReference: () => undefined,
		};
		const controller = new PermissionModeController(host as unknown as PermissionControllerHost);
		pickerNotes.length = 0;
		controller.showAutoReviewModelPicker({ kind: "missing" });
		controller.showAutoReviewModelPicker({ kind: "missing", provider: "openrouter" });
		expect(pickerNotes).toEqual([
			"No model is selected yet, so auto mode needs a review model picked here.",
			"openrouter's own coding agent has no review model, so auto mode needs one.",
		]);
	});
});
