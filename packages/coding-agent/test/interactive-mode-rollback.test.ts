import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitRollbackTurn,
	getRollbackRecoveryBlockReason,
	getRollbackTargetUserId,
	isRollbackEnabled,
	migrateRollbackSession,
	peekRollbackTurnsConsumed,
	type RollbackResult,
	rollbackLastTurn,
} from "../src/core/rollback.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("../src/core/rollback.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/rollback.ts")>();
	return {
		...original,
		isRollbackEnabled: vi.fn(() => true),
		peekRollbackTurnsConsumed: vi.fn(() => 2),
		getRollbackTargetUserId: vi.fn(),
		getRollbackRecoveryBlockReason: vi.fn(),
		rollbackLastTurn: vi.fn(),
		commitRollbackTurn: vi.fn(),
		migrateRollbackSession: vi.fn(),
	};
});

function context() {
	let sid = "original-session";
	const branch = ["first", "second", "third"].map((id) => ({ type: "message", id, message: { role: "user" } }));
	return {
		session: { isStreaming: false },
		sessionManager: { getSessionId: () => sid, getBranch: () => branch },
		runtimeHost: {
			fork: vi.fn(async () => {
				sid = "forked-session";
				return { cancelled: false, selectedText: "retry message" };
			}),
		},
		redoStack: ["old-leaf"],
		editor: { getText: () => "", setText: vi.fn() },
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
}
const proto = InteractiveMode.prototype as unknown as {
	handleRollbackCommand(this: ReturnType<typeof context>): Promise<void>;
};
function result(overrides: Partial<RollbackResult> = {}): RollbackResult {
	return {
		restored: ["/scratch/file.txt"],
		deleted: [],
		failed: [],
		complete: true,
		turnsConsumed: 0,
		turnIndex: 1,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getRollbackTargetUserId).mockReturnValue(undefined);
	vi.mocked(getRollbackRecoveryBlockReason).mockReturnValue(undefined);
	vi.mocked(rollbackLastTurn).mockReturnValue(result());
});

describe("InteractiveMode coordinated rollback", () => {
	it("keeps chat and redo unchanged after partial or total restore failure", async () => {
		for (const restored of [["/scratch/file.txt"], []]) {
			const ctx = context();
			vi.mocked(rollbackLastTurn).mockReturnValue(
				result({ restored, complete: false, failed: [{ path: "/scratch/locked.txt", error: "locked" }] }),
			);
			await proto.handleRollbackCommand.call(ctx);
			expect(ctx.runtimeHost.fork).not.toHaveBeenCalled();
			expect(commitRollbackTurn).not.toHaveBeenCalled();
			expect(ctx.redoStack).toEqual(["old-leaf"]);
			expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("Chat unchanged"));
			expect(ctx.showStatus).not.toHaveBeenCalled();
		}
	});

	it("restores before forking and releases recovery only after a successful fork", async () => {
		const ctx = context();
		await proto.handleRollbackCommand.call(ctx);
		expect(isRollbackEnabled).toHaveBeenCalledWith("original-session");
		expect(rollbackLastTurn).toHaveBeenCalledWith("original-session", { deferCommit: true, targetUserId: "second" });
		expect(ctx.runtimeHost.fork).toHaveBeenCalledWith("second", { position: "before" });
		expect(vi.mocked(rollbackLastTurn).mock.invocationCallOrder[0]).toBeLessThan(
			ctx.runtimeHost.fork.mock.invocationCallOrder[0],
		);
		expect(migrateRollbackSession).toHaveBeenCalledWith("original-session", "forked-session");
		expect(commitRollbackTurn).toHaveBeenCalledWith("forked-session", 1);
		expect(ctx.runtimeHost.fork.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(commitRollbackTurn).mock.invocationCallOrder[0],
		);
		expect(ctx.redoStack).toEqual([]);
		expect(ctx.editor.setText).toHaveBeenCalledWith("retry message");
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Rollback complete"));
	});

	it.each(["cancelled", "rejected"])(
		"retains recovery after a %s fork and retries the saved target",
		async (failure) => {
			const ctx = context();
			if (failure === "cancelled") ctx.runtimeHost.fork.mockResolvedValueOnce({ cancelled: true, selectedText: "" });
			else ctx.runtimeHost.fork.mockRejectedValueOnce(new Error("fork failed"));
			await proto.handleRollbackCommand.call(ctx);
			expect(commitRollbackTurn).not.toHaveBeenCalled();
			expect(ctx.showStatus).not.toHaveBeenCalled();
			expect(ctx.redoStack).toEqual(["old-leaf"]);
			vi.mocked(getRollbackTargetUserId).mockReturnValue("second");
			vi.mocked(peekRollbackTurnsConsumed).mockReturnValueOnce(1);
			vi.mocked(rollbackLastTurn).mockReturnValue(result({ restored: [] }));
			await proto.handleRollbackCommand.call(ctx);
			expect(ctx.runtimeHost.fork).toHaveBeenLastCalledWith("second", { position: "before" });
			expect(commitRollbackTurn).toHaveBeenCalledTimes(1);
		},
	);

	it("retains recovery without selecting another turn when its target is outside the branch", async () => {
		vi.mocked(getRollbackTargetUserId).mockReturnValue("other-branch-user");
		const ctx = context();
		await proto.handleRollbackCommand.call(ctx);
		expect(rollbackLastTurn).not.toHaveBeenCalled();
		expect(ctx.runtimeHost.fork).not.toHaveBeenCalled();
		expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("another chat branch"));
	});
});
