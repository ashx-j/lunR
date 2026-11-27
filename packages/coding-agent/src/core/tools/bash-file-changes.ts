/**
 * Finds the files a bash tool call changed, for the diff on the bash card, the model's "Files
 * changed" line and the post-change type check. It only reports: nothing here restores a file,
 * and /rollback does not know about bash changes.
 *
 * Inside a git repository only. Before and after each mutating call (`isMutatingBashCommand`),
 * `git status --porcelain=v2` of the whole repository lists the dirty and untracked paths; a path
 * in either list whose file changed is a change of that call. Every call takes both snapshots:
 * reusing one call's "after" as the next "before" would pin another program's write on the next
 * call. Changes inside submodules and nested repositories are not seen.
 *
 * The diff's earlier text is HEAD's raw blob from before the call for files that were clean (the
 * card says it compares with HEAD; no filter runs), and a copy taken before the call for files that
 * were already dirty or untracked. Between calls lunR keeps only those copies (at most
 * `MAX_COPY_BYTES`), reused while a file's stat is unchanged.
 *
 * Tracking is off, and the card says why in one line, outside git, past `MAX_INDEX_ENTRIES`
 * tracked files or `MAX_STATUS_ENTRIES` dirty and untracked ones, and after the backstop: when
 * the median added time of the last `SLOW_CALLS` tracked calls passes `SLOW_ADDED_MS`.
 */

import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isMutatingBashCommand } from "../plan-mode.ts";
import { generateDiffString } from "./edit-diff.ts";

/**
 * Repositories with more tracked files are not tracked. At this size, on a 4-core machine at load
 * under 2, a mutating call costs about 23 ms more when it changes nothing and 36 ms when it changes
 * a file (2 `git status`, and a `cat-file` for the diff).
 */
const MAX_INDEX_ENTRIES = 5000;
/**
 * Dirty and untracked paths past which tracking is off. Each costs about 20 µs per call (its line
 * in `git status` and 2 stats), so 2,000 would add about 40 ms to every call.
 */
const MAX_STATUS_ENTRIES = 1000;
/** Backstop: tracking stops when the median added time of the last SLOW_CALLS calls passes this. */
const SLOW_ADDED_MS = 50;
const SLOW_CALLS = 5;
/** A git command that has not finished by then is abandoned; that call is not listed. */
const GIT_TIMEOUT_MS = 2000;
/**
 * File reads run in parallel batches of this size. Stats run with lstatSync: for 2,000 files it
 * takes 15 ms where parallel `lstat` takes 35 to 57 ms (libuv's 4 threads, a promise per file).
 */
const READ_BATCH = 64;
/** Dirty files are copied for the diff up to these sizes, per file and per call. */
const MAX_COPY_FILE_BYTES = 512 * 1024;
const MAX_COPY_BYTES = 8 * 1024 * 1024;
/** The card gets diffs for this many files, the session file lists up to MAX_LISTED_FILES. */
const MAX_DIFF_FILES = 20;
const MAX_LISTED_FILES = 200;
const MAX_DIFF_CHARS_PER_FILE = 12_000;
const MODEL_LIST_LIMIT = 5;

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
	/** Why this call's changes are not listed (tracking off, a snapshot failed). The card shows it; the model gets nothing. */
	unlisted?: string;
}

interface StatusEntry {
	untracked: boolean;
	/** Staged state when the index differs from HEAD: the index column and the index blob. */
	staged?: string;
	/** A submodule or nested repository, not a file. */
	nested?: boolean;
	/** The mode HEAD has for a tracked path, such as "100644". */
	headMode?: string;
}

interface GitStatus {
	head: string | undefined;
	/** Keyed by path relative to the repository root. */
	entries: Map<string, StatusEntry>;
	/** Stats of `info/exclude` and `info/attributes`, to tell an edit of them. */
	infoFiles: string;
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
	/** Copy of the content (a symlink's target) before the call, for the diff. */
	content?: Buffer;
}

interface Change {
	rel: string;
	kind: BashFileChange["kind"];
	/** Dirty or absent before the call: the earlier text, if lunR copied it. Clean: undefined. */
	earlier?: Buffer;
	/** Clean (tracked, not in git status) before the call: the diff compares with HEAD's blob. */
	clean: boolean;
	/** Not dirty or untracked before the call: clean, or ignored. */
	wasClean?: true;
	/** Clean: HEAD's blob from before the call, or null when HEAD has no such path. Fetched in `compare`. */
	head?: Buffer | null;
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
export function parseStatus(output: string): Pick<GitStatus, "head" | "entries"> {
	const entries = new Map<string, StatusEntry>();
	let head: string | undefined;
	const add = (path: string, entry: StatusEntry) => {
		// A name that is not UTF-8 cannot be addressed; it is not listed.
		if (path.includes("�")) return;
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
						headMode: known.headMode ?? entry.headMode,
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
		}
		// An untracked directory entry is a nested repository; -uall lists every other untracked file.
		else if (field.startsWith("? ")) add(field.slice(2), { untracked: true, nested: field.endsWith("/") });
		else if (field.startsWith("1 ") || field.startsWith("u ")) {
			// "1 XY sub mH mI mW hH hI path"; "u XY sub m1 m2 m3 mW h1 h2 h3 path"
			const parts = field.split(" ");
			const pathAt = field.startsWith("1 ") ? 8 : 10;
			const indexBlob = field.startsWith("1 ") ? parts[7] : "";
			add(parts.slice(pathAt).join(" "), {
				untracked: false,
				staged: parts[1][0] === "." ? undefined : `${parts[1][0]}${indexBlob}`,
				nested: parts[2].startsWith("S"),
				headMode: field.startsWith("1 ") ? parts[3] : undefined,
			});
		} else if (field.startsWith("2 ")) {
			const parts = field.split(" ");
			add(parts.slice(9).join(" "), {
				untracked: false,
				staged: parts[1][0] === "." ? undefined : `${parts[1][0]}${parts[7]}`,
				nested: parts[2].startsWith("S"),
				headMode: parts[3],
			});
			// A staged rename: its source path is the next field.
			const source = fields[++i];
			if (source) add(source, { untracked: false, staged: "R" });
		}
	}
	return { head, entries };
}

function statKey(abs: string): StatKey | undefined {
	try {
		const stats = lstatSync(abs, { throwIfNoEntry: false });
		if (!stats) return undefined;
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

/** Runs `work` over `items` in parallel batches of READ_BATCH. */
async function batched<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += READ_BATCH) {
		results.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(work))));
	}
	return results;
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

/** A file's content, or a symlink's target, for a copy or a comparison. */
async function contentOf(abs: string, stat: StatKey): Promise<Buffer | undefined> {
	if (stat.kind === "symlink")
		return readlink(abs).then(
			(target) => Buffer.from(target),
			() => undefined,
		);
	if (stat.kind !== "file" || stat.size > MAX_COPY_FILE_BYTES) return undefined;
	return readFile(abs).catch(() => undefined);
}

function isBinary(content: Buffer): boolean {
	return content.subarray(0, 8000).includes(0);
}

function naturalOrder(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Entry count from an index file's header (bytes 8 to 12), or undefined when it cannot be read. */
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

/** Tracked files: the index's count, or a split index's shared count when that is larger. */
async function trackedFiles(gitDir: string): Promise<number | undefined> {
	const own = await indexEntries(join(gitDir, "index"));
	const shared = (await readdir(gitDir).catch(() => [])).filter((name) => name.startsWith("sharedindex."));
	let count = own;
	for (const name of shared) {
		const entries = await indexEntries(join(gitDir, name));
		if (entries !== undefined && (count === undefined || entries > count)) count = entries;
	}
	return count;
}

/** Numbers the clock probes, so parallel calls do not share a file. */
let probes = 0;

/** One repository's tracking state for a session. */
class RepoTracker {
	readonly cwd: string;
	readonly top: string;
	readonly gitDir: string;
	disabled: string | undefined;
	/** Added time of the last tracked calls, for the backstop. */
	private readonly added: number[] = [];
	/** Copies of dirty files from before the last call, reused while a file's stat is unchanged. */
	private readonly copies = new Map<string, DirtyFile>();

	constructor(info: { cwd: string; top: string; gitDir: string }) {
		this.cwd = info.cwd;
		this.top = info.top;
		this.gitDir = info.gitDir;
	}

	/** The whole repository's status, or undefined when git failed or timed out. */
	async status(): Promise<GitStatus | undefined> {
		// No ahead/behind walk to the upstream and no submodule checks: neither matters here and both cost.
		const [result] = await Promise.all([
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
		]);
		if (result.code !== 0) return undefined;
		const infoFiles = ["exclude", "attributes"]
			.map((name) => statKey(join(this.gitDir, "info", name)))
			.map((stat) => (stat ? `${stat.size} ${stat.mtimeMs} ${stat.ino}` : ""))
			.join(" ");
		return { ...parseStatus(result.stdout.toString("utf8")), infoFiles };
	}

	/**
	 * The filesystem's clock now: the time of a probe file written in the git dir. A file the call
	 * writes gets a time at or after it, even when lunR's clock and the filesystem's disagree.
	 */
	async clock(): Promise<number | undefined> {
		const probe = join(this.gitDir, `lunr-clock-${process.pid}-${++probes}`);
		try {
			await writeFile(probe, "");
			const stat = await lstat(probe);
			return Math.min(stat.mtimeMs, stat.ctimeMs);
		} catch {
			return undefined;
		} finally {
			await rm(probe, { force: true }).catch(() => {});
		}
	}

	/** Stats every dirty file before a call and copies the small ones for the diff. */
	async snapshotDirty(status: GitStatus): Promise<Map<string, DirtyFile>> {
		const rels = [...status.entries].filter(([, entry]) => !entry.nested).map(([rel]) => rel);
		const stats = rels.map((rel) => statKey(join(this.top, rel)));
		const dirty = new Map<string, DirtyFile>();
		const toRead: Array<{ rel: string; stat: StatKey }> = [];
		let copied = 0;
		rels.forEach((rel, i) => {
			const stat = stats[i];
			const cached = this.copies.get(rel);
			if (cached && sameStat(cached.stat, stat)) {
				dirty.set(rel, cached);
				copied += cached.content?.length ?? 0;
			} else if (stat && copied + stat.size <= MAX_COPY_BYTES) {
				copied += stat.kind === "file" ? stat.size : 0;
				toRead.push({ rel, stat });
				dirty.set(rel, { stat });
			} else dirty.set(rel, { stat });
		});
		const contents = await batched(toRead, ({ rel, stat }) => contentOf(join(this.top, rel), stat));
		toRead.forEach(({ rel, stat }, i) => {
			dirty.set(rel, { stat, content: contents[i] });
		});
		return dirty;
	}

	/** Records one tracked call's added time; stops tracking when the median of the last SLOW_CALLS passes `slowMs`. */
	measure(addedMs: number, slowMs: number): void {
		this.added.push(addedMs);
		while (this.added.length > SLOW_CALLS) this.added.shift();
		if (this.added.length < SLOW_CALLS) return;
		const median = [...this.added].sort((a, b) => a - b)[Math.floor(SLOW_CALLS / 2)];
		if (median > slowMs) {
			this.disabled = `tracking added a median ${Math.round(median)} ms to the last ${SLOW_CALLS} bash calls, over the ${slowMs} ms lunR allows`;
		}
	}

	/** Compares the 2 snapshots and returns the files the call changed. */
	async compare(
		before: GitStatus,
		dirty: Map<string, DirtyFile>,
		after: GitStatus,
		clock: number | undefined,
	): Promise<Change[]> {
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
		const cleanAndOld: Change[] = [];
		const dirtyChange = (rel: string, wasDirty: DirtyFile, stat: StatKey | undefined): Change => ({
			rel,
			kind: !wasDirty.stat ? "created" : !stat || stat.kind === "other" ? "deleted" : "modified",
			earlier: wasDirty.stat ? wasDirty.content : Buffer.alloc(0),
			clean: false,
		});
		// Same kind and mode with new stats (`touch`, a relink to the same target): compared by content below.
		const touched: Array<{ rel: string; stat: StatKey; wasDirty: DirtyFile & { content: Buffer } }> = [];
		for (const rel of candidates) {
			const stat = statKey(join(this.top, rel));
			const wasDirty = dirty.get(rel);
			// A file that became a directory is gone; the directory's files are their own entries.
			const gone = !stat || stat.kind === "other";
			if (wasDirty) {
				if (sameStat(wasDirty.stat, stat)) continue;
				if (wasDirty.stat?.kind === "other" && gone) continue;
				const { content } = wasDirty;
				if (stat && content && stat.kind === wasDirty.stat?.kind && stat.mode === wasDirty.stat.mode) {
					touched.push({ rel, stat, wasDirty: { ...wasDirty, content } });
				} else changes.push(dirtyChange(rel, wasDirty, stat));
				continue;
			}
			const change: Change = after.entries.get(rel)?.untracked
				? { rel, kind: "created", earlier: Buffer.alloc(0), clean: false, wasClean: true }
				: { rel, kind: gone ? "deleted" : "modified", clean: true, wasClean: true };
			changes.push(change);
			// Older than the probe written before the call: possibly only made visible to git (see `becameVisible`).
			if (stat && clock !== undefined && stat.mtimeMs < clock && stat.ctimeMs < clock) cleanAndOld.push(change);
		}
		const now = await batched(touched, ({ rel, stat }) => contentOf(join(this.top, rel), stat));
		touched.forEach(({ rel, stat, wasDirty }, i) => {
			if (!now[i]?.equals(wasDirty.content)) changes.push(dirtyChange(rel, wasDirty, stat));
		});
		this.copies.clear();
		for (const [rel, file] of dirty) if (file.content) this.copies.set(rel, file);
		const hidden = new Set(cleanAndOld.length > 0 && this.becameVisible(before, after, changes) ? cleanAndOld : []);
		const listed = changes.filter((change) => !hidden.has(change));
		return before.head ? this.dropUnchangedFromHead(before.head, listed, after) : listed;
	}

	/**
	 * Fetches HEAD's blob for the clean changes and drops a file whose bytes and mode still match it:
	 * git lists it because the index or attributes changed (`git rm --cached`, a rewrite with the
	 * same bytes), not because the file did.
	 */
	private async dropUnchangedFromHead(head: string, changes: Change[], after: GitStatus): Promise<Change[]> {
		const clean = changes
			.filter((change) => change.wasClean)
			.sort((a, b) => naturalOrder(a.rel, b.rel))
			.slice(0, MAX_LISTED_FILES);
		if (clean.length === 0) return changes;
		const blobs = await this.headBlobs(
			head,
			clean.map((change) => change.rel),
		);
		const unchanged = new Set<Change>();
		await batched(clean, async (change) => {
			const blob = blobs.get(change.rel);
			if (change.clean) change.head = blob;
			const headMode = after.entries.get(change.rel)?.headMode;
			if (!blob || change.kind === "deleted" || (headMode !== "100644" && headMode !== "100755")) return;
			const stat = statKey(join(this.top, change.rel));
			if (
				stat?.kind !== "file" ||
				stat.size !== blob.length ||
				(stat.mode & 0o100) !== (headMode === "100755" ? 0o100 : 0)
			)
				return;
			if ((await contentOf(join(this.top, change.rel), stat))?.equals(blob)) unchanged.add(change);
		});
		return changes.filter((change) => !unchanged.has(change));
	}

	/**
	 * Whether the call gave files a reason to show up in git status without being written: an
	 * edited `.gitignore`, `.gitattributes`, `info/exclude` or `info/attributes`, a change to the
	 * index (`git rm --cached`, a reset that moved HEAD), a nested repository whose `.git` went. Only
	 * then are files older than the call left out.
	 */
	private becameVisible(before: GitStatus, after: GitStatus, changes: Change[]): boolean {
		if (before.infoFiles !== after.infoFiles || before.head !== after.head) return true;
		const gitFile = /(^|\/)\.git(ignore|attributes)$/;
		if (changes.some((change) => gitFile.test(change.rel))) return true;
		for (const [rel, entry] of before.entries) if (entry.nested && !after.entries.get(rel)?.nested) return true;
		for (const rel of new Set([...before.entries.keys(), ...after.entries.keys()])) {
			if (before.entries.get(rel)?.staged !== after.entries.get(rel)?.staged) return true;
		}
		return false;
	}

	private async diffCommits(from: string, to: string): Promise<string[]> {
		const result = await runGit(this.top, ["diff", "--name-only", "-z", "--no-renames", from, to]);
		return result.code === 0 ? result.stdout.toString("utf8").split("\0").filter(Boolean) : [];
	}

	/** Card data: kinds for the listed files, diffs and line counts for the first MAX_DIFF_FILES. */
	async describe(changes: Change[], head: string | undefined): Promise<BashFileChange[]> {
		const sorted = [...changes].sort((a, b) => naturalOrder(a.rel, b.rel)).slice(0, MAX_LISTED_FILES);
		const withDiff = sorted.slice(0, MAX_DIFF_FILES);
		const missing = withDiff
			.filter((change) => change.clean && change.head === undefined)
			.map((change) => change.rel);
		const fromHead =
			head && missing.length > 0 ? await this.headBlobs(head, missing) : new Map<string, Buffer | null>();
		for (const change of withDiff) if (change.head !== undefined) fromHead.set(change.rel, change.head);
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
		const stat = statKey(abs);
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

/** The line appended to the bash result the model sees; none for a call whose changes are not listed. */
export function formatChangesForModel(changes: BashFileChanges): string | undefined {
	if (changes.unlisted || changes.files.length === 0) return undefined;
	const shown = changes.files.slice(0, MODEL_LIST_LIMIT).map((file) => {
		if (file.kind === "deleted") return `${file.path} (deleted)`;
		const counts = [file.added ? ` +${file.added}` : "", file.removed ? ` -${file.removed}` : ""].join("");
		return `${file.path} (${file.kind === "created" ? "new" : "modified"}${counts})`;
	});
	const rest = changes.files.length - shown.length + changes.more;
	return `Files changed: ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/**
 * The session's tracker. The bash tool calls `begin` before it spawns a command and awaits the
 * returned function after the command exits; the session takes the result in `afterToolCall`.
 */
export class BashFileChangeTracker {
	private repo: Promise<RepoTracker | undefined> | undefined;
	private repoCwd: string | undefined;
	private readonly results = new Map<string, BashFileChanges>();
	private readonly maxIndexEntries: number;
	private readonly maxStatusEntries: number;
	private readonly slowAddedMs: number;

	constructor(options: { maxIndexEntries?: number; maxStatusEntries?: number; slowAddedMs?: number } = {}) {
		this.maxIndexEntries = options.maxIndexEntries ?? MAX_INDEX_ENTRIES;
		this.maxStatusEntries = options.maxStatusEntries ?? MAX_STATUS_ENTRIES;
		this.slowAddedMs = options.slowAddedMs ?? SLOW_ADDED_MS;
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
			const tracked = await trackedFiles(gitDir);
			if (tracked !== undefined && tracked > this.maxIndexEntries) {
				repo.disabled = `the repository has ${tracked} tracked files, over the ${this.maxIndexEntries} lunR tracks`;
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
		const unlisted = (reason: string) => {
			this.results.set(toolCallId, { files: [], more: 0, unlisted: reason });
			return undefined;
		};
		const started = performance.now();
		const repo = await this.repoFor(cwd).catch(() => undefined);
		if (!repo) return unlisted("not a git repository");
		if (repo.disabled) return unlisted(repo.disabled);
		const before = await repo.status().catch(() => undefined);
		if (!before) {
			repo.measure(performance.now() - started, this.slowAddedMs);
			return unlisted("git status failed before the call");
		}
		if (before.entries.size > this.maxStatusEntries) {
			repo.disabled = `the repository has ${before.entries.size} changed or untracked files, over the ${this.maxStatusEntries} lunR tracks`;
			return unlisted(repo.disabled);
		}
		const dirty = await repo.snapshotDirty(before).catch(() => undefined);
		if (!dirty) return unlisted("the files before the call could not be read");
		const clock = await repo.clock();
		const beginMs = performance.now() - started;
		return async () => {
			const finishing = performance.now();
			try {
				const after = await repo.status();
				if (!after) {
					unlisted("git status failed after the call");
					return;
				}
				const changes = await repo.compare(before, dirty, after, clock);
				if (changes.length > 0) {
					const files = await repo.describe(changes, before.head);
					this.results.set(toolCallId, { files, more: Math.max(0, changes.length - files.length) });
				}
			} catch (error) {
				unlisted(error instanceof Error ? error.message : String(error));
			} finally {
				repo.measure(beginMs + performance.now() - finishing, this.slowAddedMs);
			}
		};
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
