import { describe, expect, it, vi } from "vitest";
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
	const host = { session, showStatus: vi.fn(), isSessionDetached: () => false };
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
