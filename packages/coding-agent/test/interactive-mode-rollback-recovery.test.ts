import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as rollback from "../src/core/rollback.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

vi.mock("node:os", async (original) => {
	const os = await original<typeof import("node:os")>();
	const fs = await import("node:fs");
	const path = await import("node:path");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-review-recovery-home-"));
	return { ...os, homedir: () => home };
});
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
afterAll(() => {
	vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
	rollback.clearRollback();
	fs.rmSync(homedir(), { recursive: true, force: true });
});

describe("coordinated recovery preservation", () => {
	it.each(["files", "chat-only", "none"])(
		"preserves recovery across %s newer turns and permits unchanged-target retry",
		async (newer) => {
			const cwd = fs.mkdtempSync(join(tmpdir(), "lunr-review-recovery-"));
			const sm = {
				getRollbackEnabled: () => true,
				getRollbackTurns: () => 2,
				getRollbackCapture: () => "copies",
				getRollbackScope: () => "tools",
			} as SettingsManager;
			let sid = `recovery-${newer}`;
			const branch = [{ type: "message", id: "user-a", message: { role: "user" } }];
			const forks: string[] = [];
			const ctx = {
				session: { isStreaming: false },
				sessionManager: { getSessionId: () => sid, getBranch: () => branch },
				runtimeHost: {
					fork: async (id: string) => {
						forks.push(id);
						branch.splice(branch.findIndex((entry) => entry.id === id));
						sid = `recovery-fork-${newer}`;
						rollback.initRollback(sm, sid);
						return { cancelled: false, selectedText: "" };
					},
				},
				redoStack: [],
				editor: { getText: () => "", setText: vi.fn() },
				showWarning: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
			};
			const handle = InteractiveMode.prototype as unknown as {
				handleRollbackCommand(this: typeof ctx): Promise<void>;
			};
			try {
				rollback.initRollback(sm, sid);
				const a = join(cwd, "a.txt");
				fs.writeFileSync(a, "a original");
				rollback.beginTurn(cwd, sid);
				rollback.rollbackSnapshotBeforeWrite(a, sid);
				fs.writeFileSync(a, "a changed");
				vi.mocked(fs.writeFileSync).mockImplementation((file, ...args) => {
					if (file === a) throw new Error("locked a");
					return realFs.writeFileSync(file, ...args);
				});
				await handle.handleRollbackCommand.call(ctx);
				expect(forks).toEqual([]);
				vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
				const b = join(cwd, "b.txt");
				fs.writeFileSync(b, "b original");
				if (newer !== "none") {
					branch.push({ type: "message", id: "user-b", message: { role: "user" } });
					rollback.beginTurn(cwd, sid);
					if (newer === "files") {
						rollback.rollbackSnapshotBeforeWrite(b, sid);
						fs.writeFileSync(b, "b changed");
					}
				}
				// Restart also retains the refusal after an otherwise unpersisted chat-only turn.
				rollback.initRollback(sm, sid);
				await handle.handleRollbackCommand.call(ctx);
				if (newer === "none") {
					expect(forks).toEqual(["user-a"]);
					expect(branch).toEqual([]);
					expect(fs.readFileSync(a, "utf8")).toBe("a original");
					expect(rollback.getRollbackStatus(sid)).toMatchObject({ turns: 0, files: 0 });
					expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("Rollback complete"));
				} else {
					expect(forks).toEqual([]);
					expect(branch.map((entry) => entry.id)).toEqual(["user-a", "user-b"]);
					expect(fs.readFileSync(a, "utf8")).toBe("a changed");
					expect(fs.readFileSync(b, "utf8")).toBe(newer === "files" ? "b changed" : "b original");
					expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("after newer turns"));
					expect(ctx.showStatus).not.toHaveBeenCalled();
					expect(rollback.getRollbackTargetUserId(sid)).toBe("user-a");
					// A later chat-only turn and repeated command must never restore orphaned B files.
					branch.push({ type: "message", id: "user-c", message: { role: "user" } });
					rollback.beginTurn(cwd, sid);
					for (let attempt = 0; attempt < 2; attempt++) {
						await handle.handleRollbackCommand.call(ctx);
						expect(forks).toEqual([]);
						expect(branch.map((entry) => entry.id)).toEqual(["user-a", "user-b", "user-c"]);
						expect(fs.readFileSync(a, "utf8")).toBe("a changed");
						expect(fs.readFileSync(b, "utf8")).toBe(newer === "files" ? "b changed" : "b original");
						expect(rollback.getRollbackTargetUserId(sid)).toBe("user-a");
						expect(() => rollback.rollbackLastTurn(sid)).toThrow("after newer turns");
					}
				}
			} finally {
				vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
