/**
 * Finds the files a bash tool call changed, for the diff on the bash card, the post-change type
 * check and the list /rollback prints. Nothing here restores a file: git cannot tell lunR with
 * certainty which bytes were on disk before a call, so /rollback lists bash changes instead.
 *
 * Inside a git repository only. Before and after each mutating call (`isMutatingBashCommand`),
 * `git status --porcelain=v2` lists the dirty and untracked paths of the whole repository; a path
 * in either list whose file changed is a change of that call. Every call takes both snapshots:
 * reusing one call's "after" as the next "before" would pin another program's write (an editor
 * save) on the next call, and a call that then reverts it (`git stash`) would lose it unnamed.
 * A mutating call lunR does not list (outside git, over the file limit, after the slow backstop,
 * a background job, processes left running) leaves a turn note, so /rollback never says
 * "complete" for it.
 *
 * The diff's earlier text is HEAD's raw blob from before the call for files that were clean
 * (the card says it compares with HEAD; no filter runs), and a copy taken before the call for
 * files that were already dirty or untracked. Repositories with more than `MAX_INDEX_ENTRIES`
 * tracked files (read from the index header) are not tracked, with one notice. Between calls lunR
 * keeps only those copies (at most `MAX_COPY_BYTES`), reused while a file's stat is unchanged.
 * Changes inside a submodule or a nested repository are not seen (`--ignore-submodules=all`).
 */

import { spawn } from "node:child_process";
import { lstat, open, readFile, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isMutatingBashCommand } from "../plan-mode.ts";
import { leftoversNoted } from "./bash-jobs.ts";
import { generateDiffString } from "./edit-diff.ts";

/**
 * Repositories with more tracked files are not tracked. At this size, on a 4-core machine at load
 * under 2, a mutating call costs 23 ms more when it changes nothing and 36 ms when it changes a
 * file (2 `git status`, and a `cat-file` for the diff).
 */
const MAX_INDEX_ENTRIES = 5000;
/** Backstop for a repository that is slow for another reason (large untracked trees, stat-dirty files). */
const SLOW_SNAPSHOT_MS = 150;
/** Snapshots whose median decides the backstop (each call takes 2). */
const SLOW_SNAPSHOTS = 3;
/** A git command that has not finished by then is abandoned. */
const GIT_TIMEOUT_MS = 2000;
/** Dirty files are copied for the diff up to these sizes, per file and per call. */
const MAX_COPY_FILE_BYTES = 512 * 1024;
const MAX_COPY_BYTES = 8 * 1024 * 1024;
/** The card gets diffs for this many files, the session file lists up to MAX_LISTED_FILES. */
const MAX_DIFF_FILES = 20;
const MAX_LISTED_FILES = 200;
const MAX_DIFF_CHARS_PER_FILE = 12_000;
const MODEL_LIST_LIMIT = 5;
/** File timestamps come from a coarse kernel clock that trails `Date.now()` by up to one tick (4 to 10 ms). */
const CLOCK_SLACK_MS = 20;
/** git-dir entries whose appearance means the call left a merge, rebase or pick in progress. */
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];

export interface BashFileChange {
	/** Path relative to the working directory, with forward slashes. */
	path: string;
	kind: "created" | "modified" | "deleted";
	/** Line counts, for the files that got a diff. */
	added?: number;
	removed?: number;
	/** Display diff in the edit tool's format, for the first MAX_DIFF_FILES text files. */
	diff?: string;
	binary?: boolean;
	/** The diff compares with HEAD's version, not with a copy of the file from before the call. */
	againstHead?: boolean;
}

export interface BashFileChanges {
	files: BashFileChange[];
	/** Changed files past MAX_LISTED_FILES: counted, not listed. */
	more: number;
	/** Nested repositories and submodules the call created or removed. */
	nested?: string[];
	/** The call moved HEAD. */
	headMoved?: string;
	/** Tracking this call failed. */
	failed?: string;
}

/** Called once per call with the absolute paths it changed and notes on git state it changed. */
export type RecordBashChanges = (paths: string[], notes: string[]) => void;

interface StatusEntry {
	untracked: boolean;
	/** Staged state: the index column and the index blob, to tell what the call staged. */
	staged?: string;
	/** A submodule or nested repository, not a file. */
	nested?: boolean;
}

interface GitStatus {
	head: string | undefined;
	branch: string | undefined;
	/** Keyed by path relative to the repository root. */
	entries: Map<string, StatusEntry>;
	/** Paths git printed that are not UTF-8, so lunR cannot address them, joined for comparison. */
	undecodable: string;
	/** Fingerprints of git-dir entries, to tell merges and stashes. */
	marks: Map<string, string>;
	ms: number;
}

/** A file's state as lstat sees it; equal stats mean the call did not touch it. */
interface StatKey {
	kind: "file" | "symlink" | "other";
	size: number;
	mtimeMs: number;
	/** Catches a same-size write that kept the mtime (`cp -p`). */
	ctimeMs: number;
	ino: number;
	mode: number;
}

interface DirtyFile {
	/** Undefined when the path did not exist before the call. */
	stat?: StatKey;
	/** Copy of the content before the call, for the diff. */
	content?: Buffer;
}

interface Change {
	rel: string;
	kind: BashFileChange["kind"];
	/** Dirty or absent before the call: the earlier text, if lunR copied it. Clean: undefined. */
	earlier?: Buffer;
	/** Clean before the call: the diff compares with HEAD's blob. */
	clean: boolean;
}

function runGit(cwd: string, args: string[], input?: string): Promise<{ code: number | null; stdout: Buffer }> {
	return new Promise((resolve) => {
		// Optional locks off: no git command here may write the index or take index.lock.
		const child = spawn("git", args, {
			cwd,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		if (input !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(input);
		}
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => resolve({ code: null, stdout: Buffer.alloc(0) }));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(chunks) });
		});
	});
}

/** Parses `git status --porcelain=v2 -z --branch --untracked-files=all`. Exported for tests. */
export function parseStatus(output: string): Pick<GitStatus, "head" | "branch" | "entries" | "undecodable"> {
	const entries = new Map<string, StatusEntry>();
	let head: string | undefined;
	let branch: string | undefined;
	const undecodable: string[] = [];
	const add = (path: string, entry: StatusEntry) => {
		if (path.includes("�")) {
			undecodable.push(path);
			return;
		}
		// `git rm --cached` lists a path twice: deleted from the index, and untracked.
		const key = path.replace(/\/$/, "");
		const known = entries.get(key);
		entries.set(
			key,
			known
				? {
						untracked: known.untracked || entry.untracked,
						staged: known.staged ?? entry.staged,
						nested: known.nested || entry.nested,
					}
				: entry,
		);
	};
	const fields = output.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.startsWith("# branch.oid ")) {
			const oid = field.slice("# branch.oid ".length);
			head = oid === "(initial)" ? undefined : oid;
		} else if (field.startsWith("# branch.head ")) branch = field.slice("# branch.head ".length);
		// An untracked directory entry is a nested repository; -uall lists every other untracked file.
		else if (field.startsWith("? ")) add(field.slice(2), { untracked: true, nested: field.endsWith("/") });
		else if (field.startsWith("1 ") || field.startsWith("u ")) {
			// "1 XY sub mH mI mW hH hI path"; "u XY sub m1 m2 m3 mW h1 h2 h3 path"
			const parts = field.split(" ");
			const pathAt = field.startsWith("1 ") ? 8 : 10;
			const indexBlob = field.startsWith("1 ") ? parts[7] : "";
			add(parts.slice(pathAt).join(" "), {
				untracked: false,
				staged: `${parts[1][0]}${indexBlob}`,
				nested: parts[2].startsWith("S"),
			});
		} else if (field.startsWith("2 ")) {
			const parts = field.split(" ");
			add(parts.slice(9).join(" "), {
				untracked: false,
				staged: `${parts[1][0]}${parts[7]}`,
				nested: parts[2].startsWith("S"),
			});
			// A staged rename: its source path is the next field.
			const source = fields[++i];
			if (source) add(source, { untracked: false, staged: "R" });
		}
	}
	return { head, branch, entries, undecodable: undecodable.sort().join("\0") };
}

async function statKey(abs: string): Promise<StatKey | undefined> {
	try {
		const stats = await lstat(abs);
		const kind = stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : "other";
		return {
			kind,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			ino: stats.ino,
			mode: stats.mode & 0o7777,
		};
	} catch {
		// ENOENT, or ENOTDIR when a parent became a file: the path does not exist.
		return undefined;
	}
}

function sameStat(a: StatKey | undefined, b: StatKey | undefined): boolean {
	if (!a || !b) return a === b;
	return (
		a.kind === b.kind &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.ino === b.ino &&
		a.mode === b.mode
	);
}

async function markOf(path: string): Promise<string> {
	const stat = await statKey(path);
	return stat ? `${stat.kind} ${stat.size} ${stat.mtimeMs} ${stat.ino}` : "";
}

function isBinary(content: Buffer): boolean {
	return content.subarray(0, 8000).includes(0);
}

function naturalOrder(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Entry count from the index header (bytes 8 to 12), or undefined when it cannot be read. */
async function indexEntries(indexPath: string): Promise<number | undefined> {
	try {
		const file = await open(indexPath, "r");
		try {
			const header = Buffer.alloc(12);
			const { bytesRead } = await file.read(header, 0, 12, 0);
			return bytesRead === 12 && header.toString("latin1", 0, 4) === "DIRC" ? header.readUInt32BE(8) : undefined;
		} finally {
			await file.close();
		}
	} catch {
		return undefined;
	}
}

/** One repository's tracking state for a session. */
class RepoTracker {
	readonly cwd: string;
	readonly top: string;
	readonly gitDir: string;
	disabled: string | undefined;
	/** Snapshot times of the last calls, for the slow backstop. */
	private readonly samples: number[] = [];
	/** Content of dirty files as the last call left them, so the next call does not read them again. */
	private readonly copies = new Map<string, DirtyFile>();

	constructor(info: { cwd: string; top: string; gitDir: string }) {
		this.cwd = info.cwd;
		this.top = info.top;
		this.gitDir = info.gitDir;
	}

	async status(): Promise<GitStatus | undefined> {
		const started = performance.now();
		// No ahead/behind walk to the upstream and no submodule checks: neither matters here and both cost.
		const [result, marks] = await Promise.all([
			// The whole repository, not only cwd: a call in `pkg/` that writes `../a.txt` still shows.
			runGit(this.top, [
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				"--untracked-files=all",
				"--no-ahead-behind",
				"--no-renames",
				"--ignore-submodules=all",
			]),
			this.marks(),
		]);
		const ms = performance.now() - started;
		if (result.code !== 0) {
			this.disabled = ms >= GIT_TIMEOUT_MS ? `git status took over ${GIT_TIMEOUT_MS} ms` : "git status failed";
			return undefined;
		}
		return { ...parseStatus(result.stdout.toString("utf8")), marks, ms };
	}

	private async marks(): Promise<Map<string, string>> {
		const paths = [
			...IN_PROGRESS.map((name) => join(this.gitDir, name)),
			join(this.gitDir, "refs", "stash"),
			join(this.gitDir, "logs", "refs", "stash"),
		];
		const marks = new Map<string, string>();
		await Promise.all(
			paths.map(async (path) => {
				marks.set(path, await markOf(path));
			}),
		);
		return marks;
	}

	/** Lstats every dirty file before a call and copies the small ones for the diff. */
	async snapshotDirty(status: GitStatus): Promise<Map<string, DirtyFile>> {
		const dirty = new Map<string, DirtyFile>();
		let copied = 0;
		for (const [rel, entry] of status.entries) {
			if (entry.nested) continue;
			const abs = join(this.top, rel);
			const stat = await statKey(abs);
			const cached = this.copies.get(rel);
			if (cached && sameStat(cached.stat, stat)) {
				dirty.set(rel, cached);
				copied += cached.content?.length ?? 0;
				continue;
			}
			const small =
				stat?.kind === "file" && stat.size <= MAX_COPY_FILE_BYTES && copied + stat.size <= MAX_COPY_BYTES;
			// A symlink's "content" is its target, so a link rewritten to the same target is no change.
			const content = small
				? await readFile(abs).catch(() => undefined)
				: stat?.kind === "symlink"
					? await readlink(abs).then(
							(target) => Buffer.from(target),
							() => undefined,
						)
					: undefined;
			copied += content?.length ?? 0;
			dirty.set(rel, { stat, content });
		}
		return dirty;
	}

	/** Stops tracking when the median of the last 3 snapshots passes `slowMs`. */
	measure(fresh: GitStatus[], slowMs: number): string | undefined {
		this.samples.push(...fresh.map((status) => status.ms));
		while (this.samples.length > SLOW_SNAPSHOTS) this.samples.shift();
		if (this.samples.length < SLOW_SNAPSHOTS) return undefined;
		const median = [...this.samples].sort((a, b) => a - b)[Math.floor(SLOW_SNAPSHOTS / 2)];
		if (median <= slowMs) return undefined;
		this.disabled = `git status took a median ${Math.round(median)} ms over the last 3 snapshots, over the ${slowMs} ms lunR allows`;
		return this.disabled;
	}

	/** Compares the 2 snapshots: the files the call changed, and what it changed outside the files. */
	async compare(
		before: GitStatus,
		dirty: Map<string, DirtyFile>,
		after: GitStatus,
		startedAt: number,
	): Promise<{ changes: Change[]; nested: string[]; notes: string[] }> {
		const candidates = new Set<string>();
		for (const status of [before, after]) {
			for (const [rel, entry] of status.entries) if (!entry.nested) candidates.add(rel);
		}
		// A checkout, reset or pull leaves the tree clean against the new HEAD: the files that differ
		// between the 2 commits are candidates too.
		if (before.head && after.head && before.head !== after.head) {
			for (const rel of await this.diffCommits(before.head, after.head)) candidates.add(rel);
		}
		const changes: Change[] = [];
		for (const rel of candidates) {
			const abs = join(this.top, rel);
			const stat = await statKey(abs);
			const wasDirty = dirty.get(rel);
			// A file that became a directory is gone; the directory's files are their own entries.
			const gone = !stat || stat.kind === "other";
			if (wasDirty) {
				if (sameStat(wasDirty.stat, stat)) continue;
				// A directory before and after (or gone): its files are their own entries.
				if (wasDirty.stat?.kind === "other" && (!stat || stat.kind === "other")) continue;
				// `touch` changes the stat, not the content: same bytes and mode is no change.
				if (stat && stat.kind === wasDirty.stat?.kind && wasDirty.stat.mode === stat.mode && wasDirty.content) {
					const now =
						stat.kind === "symlink"
							? await readlink(abs).then(
									(target) => Buffer.from(target),
									() => undefined,
								)
							: stat.size === wasDirty.content.length
								? await readFile(abs).catch(() => undefined)
								: undefined;
					if (now?.equals(wasDirty.content)) continue;
				}
				const kind = !wasDirty.stat ? "created" : gone ? "deleted" : "modified";
				changes.push({ rel, kind, earlier: wasDirty.stat ? wasDirty.content : Buffer.alloc(0), clean: false });
				continue;
			}
			// Clean or absent before. A file the call did not write (both times older than the call)
			// only became visible to git: an edited .gitignore, `git rm --cached`, a nested
			// repository's `.git` removed. That is no change of this call; its git side is a note.
			if (stat && stat.mtimeMs < startedAt - CLOCK_SLACK_MS && stat.ctimeMs < startedAt - CLOCK_SLACK_MS) continue;
			const entry = after.entries.get(rel);
			if (entry?.untracked) changes.push({ rel, kind: "created", earlier: Buffer.alloc(0), clean: false });
			else changes.push({ rel, kind: gone ? "deleted" : "modified", clean: true });
		}
		// The next call's "before" reuses a copy while the file's stat (ctime included) is unchanged.
		this.copies.clear();
		for (const [rel, file] of dirty) if (file.content) this.copies.set(rel, file);
		const nested = [...after.entries]
			.filter(([rel, entry]) => entry.nested && !before.entries.get(rel)?.nested)
			.concat([...before.entries].filter(([rel, entry]) => entry.nested && !after.entries.get(rel)?.nested))
			.map(([rel]) => rel)
			.sort(naturalOrder);
		return { changes, nested, notes: this.notes(before, after, nested) };
	}

	/** What the call changed outside the files: staged changes, merges, stashes, HEAD, nested repositories. */
	private notes(before: GitStatus, after: GitStatus, nested: string[]): string[] {
		const notes: string[] = [];
		const staged: string[] = [];
		for (const rel of new Set([...before.entries.keys(), ...after.entries.keys()])) {
			const was = before.entries.get(rel)?.staged ?? ".";
			const now = after.entries.get(rel)?.staged ?? ".";
			// After a commit, entries staged before are committed: only new staging counts then.
			const moved = before.head !== after.head;
			if (moved ? now[0] !== "." && now !== was : now !== was && (now[0] !== "." || was[0] !== "."))
				staged.push(rel);
		}
		if (staged.length > 0)
			notes.push(`A bash command changed what is staged for ${names(staged)}; /rollback does not change the index`);
		for (const name of IN_PROGRESS) {
			const path = join(this.gitDir, name);
			if (!before.marks.get(path) && after.marks.get(path)) {
				const what =
					name === "MERGE_HEAD"
						? "a merge"
						: name.startsWith("rebase")
							? "a rebase"
							: name === "REVERT_HEAD"
								? "a revert"
								: "a cherry-pick";
				notes.push(`A bash command left ${what} in progress`);
			}
		}
		const stashChanged = ["refs", "logs"].some((part) => {
			const path = part === "refs" ? join(this.gitDir, "refs", "stash") : join(this.gitDir, "logs", "refs", "stash");
			return before.marks.get(path) !== after.marks.get(path);
		});
		if (stashChanged) notes.push("A bash command created or dropped a stash; /rollback does not touch stashes");
		if (before.head !== after.head || before.branch !== after.branch) notes.push(headNote(before, after));
		if (nested.length > 0)
			notes.push(`A bash command created or removed ${names(nested.map((rel) => `${rel}/`))}, a nested repository`);
		// Only when the set of such names changed: one old file must not add a note to every call.
		if (after.undecodable !== before.undecodable)
			notes.push("A bash command changed files whose names are not UTF-8");
		return notes;
	}

	private async diffCommits(from: string, to: string): Promise<string[]> {
		const result = await runGit(this.top, ["diff", "--name-only", "-z", "--no-renames", from, to]);
		return result.code === 0 ? result.stdout.toString("utf8").split("\0").filter(Boolean) : [];
	}

	/** Card data: kinds for the listed files, diffs and line counts for the first MAX_DIFF_FILES. */
	async describe(changes: Change[], head: string | undefined): Promise<BashFileChange[]> {
		const sorted = [...changes].sort((a, b) => naturalOrder(a.rel, b.rel)).slice(0, MAX_LISTED_FILES);
		const withDiff = sorted.slice(0, MAX_DIFF_FILES);
		const fromHead = head
			? await this.headBlobs(
					head,
					withDiff.filter((change) => change.clean).map((change) => change.rel),
				)
			: new Map<string, Buffer | null>();
		const files: BashFileChange[] = [];
		for (const [index, change] of sorted.entries()) {
			const file: BashFileChange = {
				path: relative(this.cwd, join(this.top, change.rel)).split(sep).join("/"),
				kind: change.kind,
			};
			if (index < MAX_DIFF_FILES) {
				if (!change.clean) Object.assign(file, await this.diffAgainst(change, change.earlier));
				else if (fromHead.has(change.rel)) {
					const blob = fromHead.get(change.rel) ?? Buffer.alloc(0);
					Object.assign(file, await this.diffAgainst(change, blob), { againstHead: true });
				}
			}
			files.push(file);
		}
		return files;
	}

	/**
	 * HEAD's raw blob for each path (one `git cat-file --batch`), or null for a path HEAD does not
	 * have. Raw: no line-ending conversion or filter runs, so the card says it compares with HEAD.
	 */
	private async headBlobs(head: string, rels: string[]): Promise<Map<string, Buffer | null>> {
		const blobs = new Map<string, Buffer | null>();
		const asked = rels.filter((rel) => !rel.includes("\n"));
		if (asked.length === 0) return blobs;
		const result = await runGit(
			this.top,
			["cat-file", "--batch"],
			`${asked.map((rel) => `${head}:${rel}`).join("\n")}\n`,
		);
		const out = result.stdout;
		let offset = 0;
		for (const rel of asked) {
			const lineEnd = out.indexOf(10, offset);
			if (lineEnd < 0) break;
			const header = out.subarray(offset, lineEnd).toString("utf8");
			offset = lineEnd + 1;
			if (header.endsWith(" missing")) {
				blobs.set(rel, null);
				continue;
			}
			const [, type, size] = header.split(" ");
			if (type === "blob") blobs.set(rel, Buffer.from(out.subarray(offset, offset + Number(size))));
			offset += Number(size) + 1;
		}
		return blobs;
	}

	/** Diff of the file now against `earlier` (a copy from before the call, or HEAD's blob). */
	private async diffAgainst(change: Change, earlier: Buffer | undefined): Promise<Partial<BashFileChange>> {
		if (!earlier || earlier.length > MAX_COPY_FILE_BYTES) return {};
		const abs = join(this.top, change.rel);
		const stat = await statKey(abs);
		const now =
			change.kind === "deleted"
				? Buffer.alloc(0)
				: stat?.kind === "file" && stat.size <= MAX_COPY_FILE_BYTES
					? await readFile(abs).catch(() => undefined)
					: undefined;
		if (!now) return {};
		if (isBinary(earlier) || isBinary(now)) return { binary: true };
		// CRLF on one side only (core.autocrlf) is not a change to show.
		const text = (content: Buffer) => content.toString("utf8").replace(/\r\n/g, "\n");
		const { diff } = generateDiffString(text(earlier), text(now));
		let added = 0;
		let removed = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("+")) added++;
			else if (line.startsWith("-")) removed++;
		}
		return diff.length <= MAX_DIFF_CHARS_PER_FILE ? { added, removed, diff } : { added, removed };
	}
}

function names(paths: string[]): string {
	const shown = paths.slice(0, 3).join(", ");
	return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

function headNote(before: GitStatus, after: GitStatus): string {
	const short = (oid: string | undefined) => oid?.slice(0, 7) ?? "nothing";
	if (before.branch === after.branch) {
		return `A bash command moved ${after.branch ?? "HEAD"} from ${short(before.head)} to ${short(after.head)}; /rollback does not change commits`;
	}
	return `A bash command moved HEAD from ${before.branch ?? "?"} to ${after.branch ?? "?"}; /rollback does not change the branch`;
}

/** The line appended to the bash result the model sees. */
export function formatChangesForModel(changes: BashFileChanges): string {
	if (changes.failed) return `lunR could not track the files this command changed: ${changes.failed}`;
	const shown = changes.files.slice(0, MODEL_LIST_LIMIT).map((file) => {
		if (file.kind === "deleted") return `${file.path} (deleted)`;
		const counts = [file.added ? ` +${file.added}` : "", file.removed ? ` -${file.removed}` : ""].join("");
		return `${file.path} (${file.kind === "created" ? "new" : "modified"}${counts})`;
	});
	for (const rel of changes.nested ?? []) shown.push(`${rel}/ (nested repository)`);
	const rest = changes.files.length - Math.min(changes.files.length, MODEL_LIST_LIMIT) + changes.more;
	const head = changes.headMoved ? `. ${changes.headMoved}` : "";
	return `Files changed: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}${head}`;
}

/**
 * The session's tracker. The bash tool calls `begin` before it spawns a command and awaits the
 * returned function after the command exits; the session takes the result in `afterToolCall`.
 */
export class BashFileChangeTracker {
	private repo: Promise<RepoTracker | undefined> | undefined;
	private repoCwd: string | undefined;
	private readonly results = new Map<string, BashFileChanges>();
	private readonly record: RecordBashChanges | undefined;
	private readonly notify: ((message: string) => void) | undefined;
	private readonly maxIndexEntries: number;
	private readonly slowSnapshotMs: number;

	constructor(
		options: {
			record?: RecordBashChanges;
			notify?: (message: string) => void;
			maxIndexEntries?: number;
			slowSnapshotMs?: number;
		} = {},
	) {
		this.record = options.record;
		this.notify = options.notify;
		this.maxIndexEntries = options.maxIndexEntries ?? MAX_INDEX_ENTRIES;
		this.slowSnapshotMs = options.slowSnapshotMs ?? SLOW_SNAPSHOT_MS;
	}

	/** A mutating call ran whose changes lunR does not list: a turn note keeps /rollback from saying "complete". */
	private unlisted(reason: string): undefined {
		try {
			this.record?.([], [`Bash commands ran whose changes lunR does not list (${reason})`]);
		} catch {
			// Tracking must never fail the command.
		}
		return undefined;
	}

	/** The bash tool calls this for a `run_in_background` job, whose changes are never listed. */
	noteBackground(command: string): void {
		if (isMutatingBashCommand(command)) this.unlisted("a background job");
	}

	private repoFor(cwd: string): Promise<RepoTracker | undefined> {
		if (this.repo && this.repoCwd === cwd) return this.repo;
		this.repoCwd = cwd;
		this.repo = (async () => {
			// Git prints real paths; a cwd given through a symlink must match them.
			const real = await realpath(cwd).catch(() => cwd);
			const paths = await runGit(real, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
			if (paths.code !== 0) return undefined;
			const [top, gitDir] = paths.stdout.toString("utf8").trim().split("\n");
			if (!top || !gitDir) return undefined;
			const repo = new RepoTracker({ cwd: real, top, gitDir });
			const entries = await indexEntries(join(gitDir, "index"));
			if (entries !== undefined && entries > this.maxIndexEntries) {
				repo.disabled = `the repository has ${entries} tracked files, over the ${this.maxIndexEntries} lunR tracks`;
				this.notify?.(`Files changed by bash are not listed in this repository: ${repo.disabled}.`);
			}
			return repo;
		})();
		return this.repo;
	}

	/** Why bash edits are not tracked for `cwd`, or undefined while they are. Exported for tests. */
	async status(cwd: string): Promise<string | undefined> {
		const repo = await this.repoFor(cwd);
		return repo ? repo.disabled : "not a git repository";
	}

	async begin(toolCallId: string, command: string, cwd: string): Promise<(() => Promise<void>) | undefined> {
		if (!isMutatingBashCommand(command)) return undefined;
		const repo = await this.repoFor(cwd).catch(() => undefined);
		if (!repo) return this.unlisted("not a git repository");
		if (repo.disabled) return this.unlisted(repo.disabled);
		const before = await repo.status().catch(() => undefined);
		if (!before) {
			this.unlisted(repo.disabled ?? "git status failed");
			return this.stopped(repo);
		}
		const dirty = await repo.snapshotDirty(before).catch(() => undefined);
		if (!dirty) return this.unlisted("the files before the call could not be read");
		const leftovers = leftoversNoted();
		const startedAt = Date.now();
		return async () => {
			try {
				const after = await repo.status();
				if (!after) {
					this.stopped(repo);
					this.fail(toolCallId, "git status failed after the call");
					return;
				}
				const slow = repo.measure([before, after], this.slowSnapshotMs);
				if (slow) this.notify?.(`Files changed by bash are no longer listed in this repository: ${slow}.`);
				const { changes, nested, notes } = await repo.compare(before, dirty, after, startedAt);
				// Processes the call left running (`cmd &`) may write after the "after" snapshot.
				if (leftoversNoted() > leftovers) {
					notes.push("A bash command left processes running; lunR does not list what they change later");
				}
				this.record?.(
					changes.map((change) => join(repo.top, change.rel)),
					notes,
				);
				if (changes.length === 0 && nested.length === 0) return;
				const files = await repo.describe(changes, before.head);
				this.results.set(toolCallId, {
					files,
					more: Math.max(0, changes.length - files.length),
					nested: nested.length > 0 ? nested : undefined,
					headMoved: notes.find((note) => note.includes(" moved ")),
				});
			} catch (error) {
				this.fail(toolCallId, error instanceof Error ? error.message : String(error));
			}
		};
	}

	/** Tells the model and /rollback that a call's changes could not be tracked. */
	private fail(toolCallId: string, reason: string): void {
		this.results.set(toolCallId, { files: [], more: 0, failed: reason });
		try {
			this.record?.([], [`lunR could not list the files one bash command changed (${reason})`]);
		} catch {
			// Tracking must never fail the command.
		}
	}

	private stopped(repo: RepoTracker): undefined {
		this.notify?.(
			`Files changed by bash are no longer listed in this repository: ${repo.disabled ?? "git status failed"}.`,
		);
		return undefined;
	}

	/** The changes found for a finished call, once. */
	take(toolCallId: string): BashFileChanges | undefined {
		const changes = this.results.get(toolCallId);
		this.results.delete(toolCallId);
		return changes;
	}

	dispose(): void {
		this.results.clear();
	}
}
