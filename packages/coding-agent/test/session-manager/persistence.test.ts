import * as fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SESSION_VERSION, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.ts";

vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs")>();
	return { ...original, writeFileSync: vi.fn(original.writeFileSync), renameSync: vi.fn(original.renameSync) };
});
const realFs = await vi.importActual<typeof import("fs")>("fs");

describe("session persistence failure boundaries", () => {
	let dir: string;
	let session: SessionManager | undefined;
	beforeEach(() => {
		dir = fs.mkdtempSync(join(tmpdir(), "lunr-session-persistence-"));
	});
	afterEach(() => {
		vi.mocked(fs.writeFileSync).mockReset().mockImplementation(realFs.writeFileSync);
		vi.mocked(fs.renameSync).mockReset().mockImplementation(realFs.renameSync);
		session?.dispose();
		session = undefined;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function fixture(tail = "\n") {
		const file = join(dir, "session.jsonl");
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "fixture",
			timestamp: new Date().toISOString(),
			cwd: dir,
		};
		const entry = {
			type: "custom",
			id: "original",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "saved",
			data: { text: "saved" },
		};
		fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}${tail}`, { mode: 0o640 });
		session = SessionManager.open(file, dir);
		return { file, session };
	}

	it.each(["write", "rename"] as const)(
		"retains original bytes and history after replacement %s failure",
		(failure) => {
			const { file, session } = fixture();
			const original = fs.readFileSync(file);
			const entries = session.getEntries();
			if (failure === "write") {
				vi.mocked(fs.writeFileSync).mockImplementation((target, ...args) => {
					if (typeof target === "number" || String(target).endsWith(".tmp"))
						throw new Error("injected replacement write failure");
					return realFs.writeFileSync(target, ...args);
				});
			} else {
				vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
					if (destination === file) throw new Error("injected rename failure");
					return realFs.renameSync(source, destination);
				});
			}
			expect(() => session.flush()).toThrow(/injected/);
			expect(fs.readFileSync(file)).toEqual(original);
			expect(session.getEntries()).toEqual(entries);
			expect(loadEntriesFromFile(file).slice(1)).toEqual(entries);
			expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		},
	);

	it("replaces the complete log and preserves file permissions", () => {
		const { file, session } = fixture();
		session.appendCustomEntry("next", { text: "next" });
		session.flush();
		expect(loadEntriesFromFile(file).slice(1)).toEqual(session.getEntries());
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o640);
		expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"rewrites an opened symlink target while preserving the session alias",
		() => {
			const { file, session: opened } = fixture();
			opened.dispose();
			const alias = join(dir, "alias.jsonl");
			fs.symlinkSync(file, alias);
			session = SessionManager.open(alias, dir);
			session.flush();
			expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
			session.appendCustomEntry("after-flush", {});
			expect(loadEntriesFromFile(file).slice(1)).toEqual(session.getEntries());
		},
	);

	it.each(["", '\n{"type":"custom","id":"truncated"'])(
		"separates accepted history and new appends from an unterminated tail %j",
		(tail) => {
			const { file, session } = fixture(tail);
			const nextId = session.appendCustomEntry("next", { text: "next" });
			session.dispose();
			const reopened = SessionManager.open(file, dir);
			try {
				expect(reopened.getEntries().map((entry) => entry.id)).toEqual(["original", nextId]);
			} finally {
				reopened.dispose();
			}
		},
	);
});
