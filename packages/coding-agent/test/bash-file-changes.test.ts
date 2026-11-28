import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsManager } from "../src/core/settings-manager.ts";

vi.mock("node:os", async (importOriginal) => {
	const os = await importOriginal<typeof import("node:os")>();
	const fs = await import("node:fs");
	const { join } = await import("node:path");
	const home = fs.mkdtempSync(join(os.tmpdir(), "lunr-bash-changes-home-"));
	return { ...os, homedir: () => home };
});
afterAll(() => rmSync(homedir(), { recursive: true, force: true }));

const rollback = await import("../src/core/rollback.ts");
const { BashFileChangeTracker, formatChangesForModel } = await import("../src/core/tools/bash-file-changes.ts");
const { createBashToolDefinition } = await import("../src/core/tools/bash.ts");
const { BashJobs } = await import("../src/core/tools/bash-jobs.ts");
const { handleRollbackCommand } = await import("../src/modes/interactive/rollback-command.ts");
type RollbackHost = Parameters<typeof handleRollbackCommand>[0];
type Tracker = InstanceType<typeof BashFileChangeTracker>;

const dirs: string[] = [];
const git = (cwd: string, command: string) => execSync(`git ${command}`, { cwd, stdio: "pipe" });

function repo(files: Record<string, string | Buffer> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "lunr-bash-changes-"));
	dirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(join(dir, name, ".."), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	git(dir, "init -q -b main");
	git(dir, "config user.email t@example.com");
	git(dir, "config user.name t");
	git(dir, "add -A");
	git(dir, "commit -qm init --allow-empty");
	return dir;
}

function plainDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lunr-bash-changes-plain-"));
	dirs.push(dir);
	return dir;
}

/** A tracker whose backstop a loaded test machine cannot trip; the backstop has its own test. */
const newTracker = (options: ConstructorParameters<typeof BashFileChangeTracker>[0] = {}) =>
	new BashFileChangeTracker({ slowAddedMs: Number.POSITIVE_INFINITY, ...options });

let tracker: Tracker;
let calls = 0;
const jobs = new BashJobs();

/** Runs `command` through the bash tool, as the session does, and returns what the tracker found. */
async function run(cwd: string, command: string, options: { background?: boolean } = {}) {
	const id = `call-${++calls}`;
	const bash = createBashToolDefinition(cwd, { fileChanges: tracker, jobs });
	await bash.execute(id, { command, run_in_background: options.background }, undefined, undefined, {} as never);
	const changes = tracker.take(id);
	return { changes, paths: changes?.files.map((file) => file.path) ?? [] };
}

beforeEach(() => {
	tracker = newTracker();
});

afterEach(() => {
	vi.restoreAllMocks();
	jobs.stopAll();
	// Windows keeps a folder busy for a moment after a process in it exits.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("bash file changes: what a call changed", () => {
	it("lists created, modified and deleted files, and none for read-only, no-op or ignored writes", async () => {
		const cwd = repo({ "a.txt": "one\n", "gone.txt": "bye\n", ".gitignore": "*.log\n" });

		const { changes } = await run(cwd, "perl -pi -e s/one/1/ a.txt && rm gone.txt && echo n > new.txt");

		expect(formatChangesForModel(changes!)).toBe(
			"Files changed: a.txt (modified +1 -1), gone.txt (deleted), new.txt (new +1)",
		);
		expect((await run(cwd, "cat a.txt")).changes).toBeUndefined();
		expect((await run(cwd, "perl -pi -e s/nothing/x/ a.txt && touch a.txt")).changes).toBeUndefined();
		expect((await run(cwd, "echo x > out.log && touch t && rm t")).changes).toBeUndefined();
	});

	it("diffs clean files against HEAD's blob, so CRLF line endings do not show as changes", async () => {
		const cwd = repo();
		git(cwd, "config core.autocrlf true");
		writeFileSync(join(cwd, "a.txt"), "alpha\nbeta\ngamma\n");
		git(cwd, "add -A");
		git(cwd, "commit -qm crlf");
		execSync("rm a.txt && git checkout -- a.txt", { cwd });

		const { changes } = await run(cwd, "perl -pi -e s/beta/BETA/ a.txt");

		expect(formatChangesForModel(changes!)).toBe("Files changed: a.txt (modified +1 -1)");
		expect(changes?.files[0]).toMatchObject({ againstHead: true, diff: expect.stringContaining("+2 BETA") });
	});

	it("diffs dirty and new files against a copy taken before the call", async () => {
		const cwd = repo({ "a.txt": "one\ntwo\n" });
		writeFileSync(join(cwd, "a.txt"), "one\ntwo\nmine\n");

		const { changes } = await run(cwd, "perl -pi -e s/two/TWO/ a.txt && printf 'x\\ny\\n' > new.txt");

		expect(formatChangesForModel(changes!)).toBe("Files changed: a.txt (modified +1 -1), new.txt (new +2)");
		expect(changes?.files[0].againstHead).toBeUndefined();
	});

	it("keeps the other changes of a call when a parent became a file", async () => {
		const cwd = repo({ "a.txt": "a\n", "src/b.txt": "b\n" });
		const { changes } = await run(cwd, "echo MODEL > a.txt && rm -rf src && echo x > src");

		expect(changes?.files.map((file) => `${file.path} ${file.kind}`)).toEqual([
			"a.txt modified",
			"src created",
			"src/b.txt deleted",
		]);
	});

	it("sees a write outside the working directory in the same repository, and follows a symlinked cwd", async () => {
		const cwd = repo({ "a.txt": "a\n", "pkg/b.txt": "b\n" });
		expect((await run(join(cwd, "pkg"), "echo x >> ../a.txt")).paths).toEqual(["../a.txt"]);

		const link = join(plainDir(), "link");
		symlinkSync(cwd, link);
		tracker = newTracker();
		expect((await run(link, "echo y >> a.txt")).paths).toEqual(["a.txt"]);
	});

	it("does not list changes inside a nested repository", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		git(cwd, "init -q vendor");

		expect((await run(cwd, "echo x > vendor/v.txt && echo x >> a.txt && git init -q sub")).paths).toEqual(["a.txt"]);
	});

	it.skipIf(process.platform !== "linux")("leaves out a file whose name is not UTF-8", async () => {
		const cwd = repo({ "a.txt": "a\n" });

		expect((await run(cwd, "echo b >> a.txt && echo x > $'\\xff\\xfe.txt'")).paths).toEqual(["a.txt"]);
	});

	it("gives a later write by a process a call left running to no call", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		const first = await run(cwd, "(sleep 0.3; echo late > bg.txt) > /dev/null 2>&1 &");
		await vi.waitFor(() => expect(existsSync(join(cwd, "bg.txt"))).toBe(true), { timeout: 5000 });
		const second = await run(cwd, "echo b > b.txt");

		expect(first.changes).toBeUndefined();
		expect(second.paths).toEqual(["b.txt"]);
	});
});

describe("bash file changes: files that only became visible to git", () => {
	// File times come from a coarse kernel clock: a file written in the same tick as the probe
	// lunR writes before a call counts as written during the call.
	const nextTick = () => new Promise((resolve) => setTimeout(resolve, 30));

	it("leaves out files a call made visible without writing them", async () => {
		const cwd = repo({ "a.txt": "a\n", ".gitignore": "*.env\n" });
		writeFileSync(join(cwd, "old.env"), "OLD=1\n");
		await nextTick();

		expect((await run(cwd, "printf '' > .gitignore && echo n > new.txt")).paths).toEqual([".gitignore", "new.txt"]);
		expect((await run(cwd, "git rm -q --cached a.txt")).changes).toBeUndefined();
		git(cwd, "init -q vendor");
		writeFileSync(join(cwd, "vendor", "v.txt"), "v\n");
		await nextTick();
		expect((await run(cwd, "rm -rf vendor/.git")).changes).toBeUndefined();
	});

	it("leaves out files an attributes change or a same-bytes rewrite made git list", async () => {
		const cwd = repo({ "b.txt": "b\n" });
		// f.up is checked out through a smudge filter; without the attribute git compares the smudged bytes.
		git(cwd, `config filter.up.clean "sed 's/^> //'"`);
		git(cwd, `config filter.up.smudge "sed 's/^/> /'"`);
		writeFileSync(join(cwd, ".gitattributes"), "*.up filter=up\n");
		writeFileSync(join(cwd, "f.up"), "hello\n");
		git(cwd, "add -A");
		git(cwd, "commit -qm filter");
		execSync("rm f.up && git checkout -- f.up", { cwd });
		await nextTick();

		const removed = await run(cwd, "echo back > .gitattributes");
		expect(execSync("git status --porcelain", { cwd }).toString()).toContain(" M f.up");
		expect(removed.paths).toEqual([".gitattributes"]);
		expect(
			(await run(cwd, "git rm -q --cached b.txt && cat b.txt > t && cat t > b.txt && rm t")).changes,
		).toBeUndefined();
	});

	// With lunR's clock ahead of the filesystem's, a test against `Date.now()` took a file the
	// call wrote for an old one and dropped it.
	for (const aheadMs of [40, 1000]) {
		it(`lists every file a call wrote with lunR's clock ${aheadMs} ms ahead of the file times`, async () => {
			const cwd = repo({ "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "*.env\n" });
			const now = Date.now.bind(Date);
			vi.spyOn(Date, "now").mockImplementation(() => now() + aheadMs);

			// Each call also gives a reason for files to become visible.
			const ignore = await run(cwd, "echo '*.tmp' >> .gitignore && echo x >> a.txt && echo n > new.txt");
			const staged = await run(cwd, "git rm -q --cached b.txt && echo y >> a.txt");

			expect(ignore.paths).toEqual([".gitignore", "a.txt", "new.txt"]);
			expect(staged.paths).toEqual(["a.txt"]);
		});
	}
});

describe("bash file changes: when they are not listed", () => {
	it("says why on the card and gives the model no line", async () => {
		const statusHeavy = repo({ "a.txt": "a\n" });
		for (const name of ["u1", "u2", "u3"]) writeFileSync(join(statusHeavy, name), "");
		const cases: Array<{ cwd: string; tracker: Tracker; reason: string }> = [
			{ cwd: plainDir(), tracker: newTracker(), reason: "not a git repository" },
			{
				cwd: repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" }),
				tracker: newTracker({ maxIndexEntries: 2 }),
				reason: "the repository has 3 tracked files, over the 2 lunR tracks",
			},
			{
				cwd: statusHeavy,
				tracker: newTracker({ maxStatusEntries: 2 }),
				reason: "the repository has 3 changed or untracked files, over the 2 lunR tracks",
			},
		];
		for (const { cwd, tracker: limited, reason } of cases) {
			tracker = limited;
			const { changes } = await run(cwd, "echo x >> a.txt");
			expect(changes).toEqual({ files: [], more: 0, unlisted: reason });
			expect(formatChangesForModel(changes!)).toBeUndefined();
			// The limit holds for the session, even once the cause is gone.
			rmSync(join(cwd, "u1"), { force: true });
			expect((await run(cwd, "echo y >> a.txt")).changes?.unlisted).toBe(reason);
		}
	});

	it("marks a call whose snapshot failed, and tracks the next one", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		const index = readFileSync(join(cwd, ".git", "index"));

		const broken = await run(cwd, "echo x >> a.txt && printf junk > .git/index");
		writeFileSync(join(cwd, ".git", "index"), index);
		const next = await run(cwd, "echo y >> a.txt");

		expect(broken.changes?.unlisted).toBe("git status failed after the call");
		expect(next.paths).toEqual(["a.txt"]);
	});

	it("stops for the session when the median added time of the last 5 calls passes the limit", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		tracker = new BashFileChangeTracker({ slowAddedMs: 0 });

		for (let n = 1; n <= 5; n++) expect((await run(cwd, `echo ${n} >> a.txt`)).paths).toEqual(["a.txt"]);
		expect((await run(cwd, "echo 6 >> a.txt")).changes?.unlisted).toMatch(
			/^tracking added a median \d+ ms to the last 5 bash calls, over the 0 ms lunR allows$/,
		);
	});
});

describe("bash file changes: /rollback", () => {
	// dev/tui prints the same text and restores the same files: /rollback knows nothing of bash.
	const host = (status: string[]) => ({
		session: { isStreaming: false },
		sessionManager: {
			getSessionId: () => "bash-changes",
			getBranch: () => [{ type: "message", id: "u1", message: { role: "user" } }],
		},
		runtimeHost: { fork: async () => ({ cancelled: false, selectedText: "" }) },
		editor: { getText: () => "", setText: () => {} },
		redoStack: [],
		showStatus: (message: string) => status.push(message),
		showWarning: (message: string) => status.push(`warning: ${message}`),
		showError: (message: string) => status.push(`error: ${message}`),
	});

	beforeEach(() => {
		rollback.clearRollback();
		const settings: Partial<SettingsManager> = {
			getRollbackEnabled: () => true,
			getRollbackTurns: () => 5,
			getRollbackCapture: () => "copies",
			getRollbackScope: () => "tools",
		};
		rollback.initRollback(settings as SettingsManager, "bash-changes");
	});
	afterEach(() => rollback.clearRollback());

	it("restores the edit, leaves the bash change, and prints what dev/tui prints", async () => {
		const cwd = repo({ "edited.txt": "before\n", "bash.txt": "b\n" });
		rollback.beginTurn(cwd);
		rollback.rollbackSnapshotBeforeWrite(join(cwd, "edited.txt"));
		writeFileSync(join(cwd, "edited.txt"), "edit tool\n");
		expect((await run(cwd, "echo bash >> bash.txt")).paths).toEqual(["bash.txt"]);
		const status: string[] = [];

		await handleRollbackCommand(host(status) as unknown as RollbackHost);

		expect(status).toEqual(["Rollback complete — 1 file(s) restored (edited.txt)."]);
		expect(readFileSync(join(cwd, "edited.txt"), "utf8")).toBe("before\n");
		expect(readFileSync(join(cwd, "bash.txt"), "utf8")).toBe("b\nbash\n");
	});

	// The turn from beginTurn has no files, so its "file recovery complete" restores nothing.
	it("makes no rollback point for a bash-only turn", async () => {
		const cwd = repo({ "bash.txt": "b\n" });
		rollback.beginTurn(cwd);
		expect((await run(cwd, "echo bash >> bash.txt")).paths).toEqual(["bash.txt"]);
		const status: string[] = [];

		expect(rollback.getRollbackStatus("bash-changes").files).toBe(0);
		await handleRollbackCommand(host(status) as unknown as RollbackHost);

		expect(status).toEqual(["Rollback complete — file recovery complete."]);
		expect(readFileSync(join(cwd, "bash.txt"), "utf8")).toBe("b\nbash\n");
	});
});
