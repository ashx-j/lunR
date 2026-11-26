import { execSync } from "node:child_process";
import * as fs from "node:fs";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	// Commands under test (merge, stash, commit) need an identity; the test profile has none.
	git(dir, "config user.email t@example.com");
	git(dir, "config user.name t");
	git(dir, "add -A");
	git(dir, "commit -qm init --allow-empty");
	return dir;
}

/** Every path under `dir` except .git, with its kind, content or link target, and mode. */
function tree(dir: string, rel = ""): Map<string, string> {
	const state = new Map<string, string>();
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		const abs = join(dir, path);
		const mode = (lstatSync(abs).mode & 0o777).toString(8);
		if (entry.isSymbolicLink()) state.set(path, `link ${readlinkSync(abs)}`);
		else if (entry.isDirectory()) for (const [p, v] of tree(dir, path)) state.set(p, v);
		else state.set(path, `${mode} ${readFileSync(abs).toString("base64")}`);
	}
	return state;
}

let tracker: Tracker;
let notices: string[];
let calls = 0;

const jobs = new BashJobs();

/** Runs `command` through the bash tool, as the session does, and returns what the model would be told. */
async function run(cwd: string, command: string, options: { background?: boolean } = {}) {
	const id = `call-${++calls}`;
	let tracked = false;
	const fileChanges = {
		begin: async (...args: Parameters<Tracker["begin"]>) => {
			const finish = await tracker.begin(...args);
			tracked = finish !== undefined;
			return finish;
		},
		noteBackground: (background: string) => tracker.noteBackground(background),
	};
	const bash = createBashToolDefinition(cwd, { fileChanges, jobs });
	await bash.execute(id, { command, run_in_background: options.background }, undefined, undefined, {} as never);
	return { tracked, changes: tracker.take(id) };
}

let scope: "tools" | "tree" = "tools";
let capture: "copies" | "hybrid" = "copies";

beforeEach(() => {
	notices = [];
	scope = "tools";
	capture = "copies";
	tracker = new BashFileChangeTracker({
		record: (paths, notes) => rollback.rollbackRecordBashChanges(paths, notes),
		notify: (message) => notices.push(message),
		// A loaded test machine must not turn tracking off; the backstop has its own test.
		slowSnapshotMs: Number.POSITIVE_INFINITY,
	});
	rollback.clearRollback();
	const settings: Partial<SettingsManager> = {
		getRollbackEnabled: () => true,
		getRollbackTurns: () => 5,
		getRollbackCapture: () => capture,
		getRollbackScope: () => scope,
	};
	rollback.initRollback(settings as SettingsManager, "bash-changes");
});

afterEach(() => {
	jobs.stopAll();
	rollback.clearRollback();
	// Windows keeps a folder busy for a moment after a process in it exits.
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("bash file changes: /rollback lists them and never writes them", () => {
	it("leaves every file only bash changed as it is, lists it, and does not say complete", async () => {
		const cwd = repo({ "a.txt": "one\n", "gone.txt": "bye\n", ".gitignore": "*.env\n", "src/b.txt": "b\n" });
		writeFileSync(join(cwd, "secret.env"), "SECRET=1\n");
		rollback.beginTurn(cwd);
		await run(
			cwd,
			"perl -pi -e s/one/1/ a.txt && rm gone.txt && echo n > new.txt && rm .gitignore && echo 2 >> secret.env",
		);
		await run(cwd, "rm -rf src && echo x > src");
		const after = tree(cwd);

		const result = rollback.rollbackLastTurn();

		expect(tree(cwd)).toEqual(after);
		expect(result.restored).toEqual([]);
		expect(result.deleted).toEqual([]);
		expect(result.notRestored.map((path) => path.slice(cwd.length + 1).replaceAll("\\", "/")).sort()).toEqual(
			[".gitignore", "a.txt", "gone.txt", "new.txt", "secret.env", "src", "src/b.txt"].sort(),
		);
		expect(rollback.rollbackSummary(result)).toBe(
			"Rollback finished. Not restored, changed by bash commands: .gitignore, a.txt, gone.txt, new.txt, secret.env and 2 more.",
		);
	});

	it("/rollback shows the files bash changed and does not say complete", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		rollback.beginTurn(cwd);
		await run(cwd, "echo bash >> a.txt");
		const status: string[] = [];
		const host = {
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
		};

		await handleRollbackCommand(host as unknown as RollbackHost);

		expect(status).toEqual(["Rollback finished. Not restored, changed by bash commands: a.txt."]);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a\nbash\n");
	});

	it("still restores edit and write snapshots, and lists only the bash files they do not cover", async () => {
		const cwd = repo({ "edited.txt": "before\n", "bash.txt": "b\n" });
		rollback.beginTurn(cwd);
		rollback.rollbackSnapshotBeforeWrite(join(cwd, "edited.txt"));
		writeFileSync(join(cwd, "edited.txt"), "edit tool\n");
		// dev/tui: a file the edit tool snapshotted is restored to its content before the edit,
		// which also undoes what bash did to it later in the turn.
		await run(cwd, "echo bash >> edited.txt && echo bash >> bash.txt");

		const result = rollback.rollbackLastTurn();

		expect(result.restored).toEqual([join(cwd, "edited.txt")]);
		expect(readFileSync(join(cwd, "edited.txt"), "utf8")).toBe("before\n");
		expect(readFileSync(join(cwd, "bash.txt"), "utf8")).toBe("b\nbash\n");
		expect(result.notRestored).toEqual([join(cwd, "bash.txt")]);
		expect(rollback.rollbackSummary(result)).toBe(
			"Rollback finished — 1 file(s) restored (edited.txt). Not restored, changed by bash commands: bash.txt.",
		);
	});

	it("names the git state a call left: staged changes, a merge, a stash, a commit", async () => {
		const cwd = repo({ "a.txt": "a\n", "b.txt": "b\n" });
		git(cwd, "checkout -q -b side");
		writeFileSync(join(cwd, "a.txt"), "side\n");
		git(cwd, "commit -qam side");
		git(cwd, "checkout -q main");
		writeFileSync(join(cwd, "a.txt"), "main\n");
		git(cwd, "commit -qam main");
		const turn = async (command: string) => {
			rollback.beginTurn(cwd);
			await run(cwd, command);
			return rollback.rollbackLastTurn().notes;
		};

		expect(await turn("echo x >> b.txt && git add b.txt")).toEqual([
			"A bash command changed what is staged for b.txt; /rollback does not change the index",
		]);
		git(cwd, "reset -q --hard");
		expect(await turn("git merge -q side || true")).toContain("A bash command left a merge in progress");
		git(cwd, "merge --abort");
		expect(await turn("echo y >> b.txt && git stash -q")).toContain(
			"A bash command created or dropped a stash; /rollback does not touch stashes",
		);
		const commit = await turn("echo z >> b.txt && git commit -qam z");
		expect(commit.some((note) => /^A bash command moved main from \w{7} to \w{7}/.test(note))).toBe(true);
	});

	it("reports a nested repository only when the call creates or removes it", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		git(cwd, "init -q vendor");
		const untouched = await run(cwd, "echo x >> a.txt");
		const created = await run(cwd, "git init -q sub");

		expect(formatChangesForModel(untouched.changes!)).toBe("Files changed: a.txt (modified +1)");
		expect(formatChangesForModel(created.changes!)).toBe("Files changed: sub/ (nested repository)");
	});
});

describe("bash file changes: the card's diff", () => {
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
});

describe("bash file changes: /rollback never says complete after a change it did not list", () => {
	const turn = async (cwd: string, command: string, options: { background?: boolean } = {}) => {
		rollback.beginTurn(cwd);
		await run(cwd, command, options);
		const result = rollback.rollbackLastTurn();
		return { notes: result.notes, summary: rollback.rollbackSummary(result) };
	};

	it("notes calls outside git, over the file limit, after the backstop, and background jobs", async () => {
		const plain = mkdtempSync(join(tmpdir(), "lunr-bash-changes-plain-"));
		dirs.push(plain);
		expect(await turn(plain, "echo x > a.txt")).toEqual({
			notes: ["Bash commands ran whose changes lunR does not list (not a git repository)"],
			summary: "Rollback finished. Bash commands ran whose changes lunR does not list (not a git repository).",
		});

		const cwd = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
		tracker = new BashFileChangeTracker({
			maxIndexEntries: 2,
			record: (p, n) => rollback.rollbackRecordBashChanges(p, n),
		});
		expect((await turn(cwd, "echo 1 >> a.txt")).notes).toEqual([
			"Bash commands ran whose changes lunR does not list (the repository has 3 tracked files, over the 2 lunR tracks)",
		]);

		tracker = new BashFileChangeTracker({
			slowSnapshotMs: 0,
			record: (p, n) => rollback.rollbackRecordBashChanges(p, n),
		});
		for (const n of [1, 2]) await run(cwd, `echo ${n} >> a.txt`);
		expect((await turn(cwd, "echo 3 >> a.txt")).notes).toEqual([
			expect.stringMatching(/^Bash commands ran whose changes lunR does not list \(git status took a median/),
		]);

		tracker = new BashFileChangeTracker({ record: (p, n) => rollback.rollbackRecordBashChanges(p, n) });
		expect((await turn(cwd, "echo bg >> b.txt", { background: true })).notes).toEqual([
			"Bash commands ran whose changes lunR does not list (a background job)",
		]);
		await vi.waitFor(() => expect(jobs.running()).toEqual([]), { timeout: 5000 });
	});

	it("sees a write outside the working directory, in the same repository", async () => {
		const cwd = repo({ "a.txt": "a\n", "pkg/b.txt": "b\n" });
		const { changes } = await run(join(cwd, "pkg"), "echo x >> ../a.txt");

		expect(changes?.files.map((file) => file.path)).toEqual(["../a.txt"]);
	});

	it("says what complete covers after a tracked bash call", async () => {
		const cwd = repo({ "a.txt": "a\n", ".gitignore": "*.log\n" });
		expect((await turn(cwd, "echo x > out.log")).summary).toBe(
			"Rollback complete for the files git tracks — file recovery complete. Bash changes to files git ignores and to permissions are not covered.",
		);
	});

	it("tree scope restores what it captured and lists a bash-created file it leaves", async () => {
		scope = "tree";
		const cwd = repo({ "a.txt": "a\n" });
		for (const mode of ["copies", "hybrid"] as const) {
			capture = mode;
			rollback.beginTurn(cwd);
			await run(cwd, "echo X >> a.txt && echo N > new.txt");
			rollback.captureTreeChanges(cwd);
			const result = rollback.rollbackLastTurn();

			expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a\n");
			if (mode === "copies") {
				expect(result.notRestored).toEqual([join(cwd, "new.txt")]);
				expect(rollback.rollbackSummary(result)).toMatch(
					/^Rollback finished .*Not restored, changed by bash commands: new\.txt\.$/,
				);
				rmSync(join(cwd, "new.txt"));
			} else {
				expect(result.deleted).toEqual([join(cwd, "new.txt")]);
				expect(result.notRestored).toEqual([]);
			}
		}
	});

	it.skipIf(process.platform !== "linux")("does not note an old file whose name is not UTF-8", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		execSync("echo x > $'old\\xff.txt'", { cwd, shell: "/bin/bash" });

		expect((await turn(cwd, "echo 1 >> a.txt")).notes).toEqual([]);
	});
});

describe("bash file changes: detection", () => {
	it("gives a later write by a process a call left running to no call, and notes it", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		rollback.beginTurn(cwd);
		const first = await run(cwd, "(sleep 1; echo late > bg.txt) > /dev/null 2>&1 &");
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const second = await run(cwd, "echo b > b.txt");

		expect(first.changes).toBeUndefined();
		expect(second.changes?.files.map((file) => file.path)).toEqual(["b.txt"]);
		if (process.platform !== "win32") {
			expect(rollback.rollbackLastTurn().notes).toEqual([
				"A bash command left processes running; lunR does not list what they change later",
			]);
		}
	});

	it("skips read-only commands, commands that change nothing, and ignored files", async () => {
		const cwd = repo({ "a.txt": "a\n", ".gitignore": "*.log\n" });

		expect((await run(cwd, "cat a.txt")).tracked).toBe(false);
		expect((await run(cwd, "perl -pi -e s/nothing/x/ a.txt")).changes).toBeUndefined();
		expect((await run(cwd, "echo x > out.log && touch t && rm t")).changes).toBeUndefined();
	});

	it("does not track outside git or past the index limit, and stops when snapshots stay slow", async () => {
		const plain = mkdtempSync(join(tmpdir(), "lunr-bash-changes-plain-"));
		dirs.push(plain);
		expect((await run(plain, "echo x > a.txt")).tracked).toBe(false);
		expect(await tracker.status(plain)).toBe("not a git repository");

		const cwd = repo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
		tracker = new BashFileChangeTracker({ maxIndexEntries: 2, notify: (message) => notices.push(message) });
		expect((await run(cwd, "echo 1 >> a.txt")).tracked).toBe(false);
		expect(notices).toEqual([
			"Files changed by bash are not listed in this repository: the repository has 3 tracked files, over the 2 lunR tracks.",
		]);

		notices = [];
		tracker = new BashFileChangeTracker({ slowSnapshotMs: 0, notify: (message) => notices.push(message) });
		// Each call takes 2 snapshots: the backstop has its 3 after the second call.
		for (const n of [1, 2]) expect((await run(cwd, `echo ${n} >> a.txt`)).tracked).toBe(true);
		expect((await run(cwd, "echo 3 >> a.txt")).tracked).toBe(false);
		expect(notices).toEqual([
			expect.stringMatching(
				/^Files changed by bash are no longer listed in this repository: git status took a median/,
			),
		]);
	});

	it("follows a working directory given through a symlink, and notes names that are not UTF-8", async () => {
		const cwd = repo({ "a.txt": "a\n" });
		const link = join(mkdtempSync(join(tmpdir(), "lunr-bash-changes-link-")), "link");
		dirs.push(join(link, ".."));
		fs.symlinkSync(cwd, link);
		rollback.beginTurn(cwd);

		// macOS refuses names that are not UTF-8, and Windows maps them to valid ones.
		const nonUtf8 = process.platform === "linux";
		const { changes } = await run(link, `echo b >> a.txt${nonUtf8 ? " && echo x > $'\\xff\\xfe.txt'" : ""}`);

		expect(changes?.files.map((file) => file.path)).toEqual(["a.txt"]);
		expect(rollback.rollbackLastTurn().notes).toEqual(
			nonUtf8 ? ["A bash command changed files whose names are not UTF-8"] : [],
		);
	});
});
