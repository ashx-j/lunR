/**
 * lunR: rollback service — pre-edit file snapshots for /rollback.
 *
 * Captures pre-write file content before edit/write tools mutate files, keyed
 * by user-turn. `/rollback` restores the newest non-empty turn's snapshots and
 * then rewinds the conversation via a session fork (persistent, unlike /undo).
 *
 * Capture modes (setting `rollbackCapture`):
 *  - copies:  snapshot pre-write content; restore = write back + delete files
 *             the agent created with edit/write.
 *  - hybrid:  copies + also delete files created OUTSIDE tools (tree scope).
 *  - shadow-git: hidden git repo (deferred — behaves like copies).
 *
 * Scope (setting `rollbackScope`):
 *  - tools: only edit/write tool changes.
 *  - tree:  also catches bash side-effects. Baseline = `git status --porcelain`
 *           at turn START (pre-change content); at agent_end, files that are
 *           dirty but were clean/absent at baseline are captured too (untracked
 *           = created during the turn; tracked = restored from HEAD). Skipped
 *           with a one-time warning when cwd is not a repo.
 *
 * Snapshots persist on disk under `~/.lunr/rollback/<session-id>/<turn-n>/`
 * (manifest.json + sha1-named .snap payloads) and are reloaded on init, so
 * rollback survives restarts. Turn granularity = one user message → agent_end.
 * Retention prunes beyond `rollbackTurns` turns.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SettingsManager } from "./settings-manager.ts";

export interface Snapshot {
	existed: boolean;
	content?: Buffer;
	createdByTool: boolean;
}

interface TurnSnapshots {
	turnIndex: number;
	files: Map<string, Snapshot>;
}

interface ManifestEntry {
	existed: boolean;
	createdByTool: boolean;
	snapFile?: string;
}

const ROLLBACK_BASE = join(homedir(), ".lunr", "rollback");

let sessionForceEnabled = false;
let settingsManager: SettingsManager | undefined;
let sessionId = "default";
let turns: TurnSnapshots[] = [];
let currentTurnIndex = -1;
let repoWarningShown = false;
let warningHandler: ((message: string) => void) | undefined;

/** Register a sink for one-time user-facing warnings (e.g. tree scope outside a git repo). */
export function setRollbackWarningHandler(handler: ((message: string) => void) | undefined): void {
	warningHandler = handler;
}

export function initRollback(sm: SettingsManager, sid: string): void {
	settingsManager = sm;
	sessionId = sid;
	turns = [];
	currentTurnIndex = -1;
	sessionForceEnabled = false;
	repoWarningShown = false;
	loadPersistedTurns();
}

export function isRollbackEnabled(): boolean {
	return (settingsManager?.getRollbackEnabled() ?? false) || sessionForceEnabled;
}

export function enableRollbackForSession(): void {
	sessionForceEnabled = true;
}

export function disableRollbackForSession(): void {
	sessionForceEnabled = false;
}

function pruneTurns(): void {
	const maxTurns = settingsManager?.getRollbackTurns() ?? 2;
	while (turns.length > maxTurns) {
		const old = turns.shift();
		if (old) cleanupTurnFiles(old);
	}
}

/**
 * Begin a new turn: push a new snapshot map, prune old turns beyond retention.
 * When `cwd` is given and scope is `tree`, also capture the pre-turn baseline
 * (content of all currently dirty/untracked files) so bash side-effects can be
 * restored later.
 */
export function beginTurn(cwd?: string): void {
	if (!isRollbackEnabled()) return;
	currentTurnIndex++;
	turns.push({ turnIndex: currentTurnIndex, files: new Map() });
	pruneTurns();
	if (cwd && settingsManager?.getRollbackScope() === "tree") {
		captureTreeBaseline(cwd);
	}
}

/** Capture pre-write content for a file path, recording under the current turn. */
export function rollbackSnapshotBeforeWrite(absPath: string): void {
	if (!isRollbackEnabled()) return;
	if (currentTurnIndex < 0 || turns.length === 0) beginTurn();
	const turn = turns[turns.length - 1];
	if (!turn) return;
	if (turn.files.has(absPath)) return; // already snapshotted this turn

	try {
		const existed = existsSync(absPath);
		let content: Buffer | undefined;
		if (existed) {
			content = readFileSync(absPath);
		}
		turn.files.set(absPath, {
			existed,
			content,
			createdByTool: true,
		});
		persistSnapshot(turn, absPath);
	} catch {
		// snapshot failures are non-fatal
	}
}

/**
 * Tree scope, turn START: snapshot the current (pre-turn) content of every
 * dirty/untracked file so modifications made during the turn can be restored.
 */
function captureTreeBaseline(cwd: string): void {
	const turn = turns[turns.length - 1];
	if (!turn) return;
	const entries = gitPorcelain(cwd);
	if (!entries) return;
	for (const { path } of entries) {
		if (!path) continue;
		const abs = join(cwd, path);
		if (turn.files.has(abs)) continue;
		try {
			const existed = existsSync(abs);
			turn.files.set(abs, {
				existed,
				content: existed ? readFileSync(abs) : undefined,
				createdByTool: false,
			});
			persistSnapshot(turn, abs);
		} catch {
			// skip unreadable
		}
	}
}

/**
 * Tree scope, turn END: pick up files that became dirty during the turn but
 * were clean/absent at baseline. Untracked = created during the turn (deleted
 * on restore under hybrid); tracked-modified = restore from HEAD content.
 */
export function captureTreeChanges(cwd: string): void {
	if (!isRollbackEnabled()) return;
	if (settingsManager?.getRollbackScope() !== "tree") return;
	if (currentTurnIndex < 0 || turns.length === 0) return;
	const turn = turns[turns.length - 1];
	if (!turn) return;

	const entries = gitPorcelain(cwd);
	if (!entries) return;
	for (const { status, path } of entries) {
		if (!path) continue;
		const abs = join(cwd, path);
		if (turn.files.has(abs)) continue;
		try {
			if (status === "??") {
				// Untracked now and not in the baseline — created during this turn.
				turn.files.set(abs, { existed: false, createdByTool: false });
				persistSnapshot(turn, abs);
			} else {
				// Tracked file that was clean at turn start; original = HEAD content.
				const head = spawnSync("git", ["show", `HEAD:${path}`], {
					cwd,
					timeout: 5000,
					maxBuffer: 32 * 1024 * 1024,
				});
				if (head.error || head.status !== 0 || !head.stdout) continue;
				turn.files.set(abs, {
					existed: true,
					content: head.stdout as Buffer,
					createdByTool: false,
				});
				persistSnapshot(turn, abs);
			}
		} catch {
			// skip unreadable
		}
	}
}

/**
 * Run `git status --porcelain -z` and parse entries, or return undefined (with
 * a one-time warning) when cwd is not a repo / git fails. Rename entries emit
 * their source path as a separate bare field — skipped via `skipNext`.
 */
function gitPorcelain(cwd: string): Array<{ status: string; path: string }> | undefined {
	try {
		const result = spawnSync("git", ["status", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 5000 });
		if (result.error || result.status !== 0) {
			warnOnce("Rollback tree scope: not a git repository (or git failed) — bash side-effects won't be captured.");
			return undefined;
		}
		const fields = (result.stdout ?? "").split("\0").filter((f) => f.length > 0);
		const entries: Array<{ status: string; path: string }> = [];
		let skipNext = false;
		for (const field of fields) {
			if (skipNext) {
				skipNext = false; // rename source path (bare field after an "R" entry)
				continue;
			}
			const status = field.slice(0, 2);
			const path = field.slice(3);
			if (status.includes("R")) skipNext = true;
			entries.push({ status, path });
		}
		return entries;
	} catch {
		warnOnce("Rollback tree scope: not a git repository (or git failed) — bash side-effects won't be captured.");
		return undefined;
	}
}

function warnOnce(message: string): void {
	if (repoWarningShown) return;
	repoWarningShown = true;
	try {
		warningHandler?.(message);
	} catch {
		// warning delivery is best-effort
	}
}

function persistSnapshot(turn: TurnSnapshots, absPath: string): void {
	try {
		const snap = turn.files.get(absPath);
		if (!snap) return;
		const turnDir = getTurnDir(turn.turnIndex);
		mkdirSync(turnDir, { recursive: true });
		const manifestPath = join(turnDir, "manifest.json");
		const manifest = readManifest(manifestPath);
		const entry: ManifestEntry = { existed: snap.existed, createdByTool: snap.createdByTool };
		if (snap.content) {
			const snapFile = snapFileName(absPath);
			writeFileSync(join(turnDir, snapFile), snap.content);
			entry.snapFile = snapFile;
		}
		manifest[absPath] = entry;
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	} catch {
		// disk persistence failures are non-fatal
	}
}

function readManifest(path: string): Record<string, ManifestEntry> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

/** Reload persisted turns from disk (called by initRollback) so rollback survives restarts. */
function loadPersistedTurns(): void {
	try {
		const sessionDir = join(ROLLBACK_BASE, sessionId);
		if (!existsSync(sessionDir)) return;
		const loaded: TurnSnapshots[] = [];
		for (const dirName of readdirSync(sessionDir)) {
			const match = /^turn-(\d+)$/.exec(dirName);
			if (!match) continue;
			const turnIndex = Number(match[1]);
			const turnDir = join(sessionDir, dirName);
			const manifest = readManifest(join(turnDir, "manifest.json"));
			const files = new Map<string, Snapshot>();
			for (const [absPath, meta] of Object.entries(manifest)) {
				let content: Buffer | undefined;
				if (meta.snapFile) {
					try {
						content = readFileSync(join(turnDir, meta.snapFile));
					} catch {
						content = undefined;
					}
				}
				files.set(absPath, { existed: meta.existed, content, createdByTool: meta.createdByTool });
			}
			loaded.push({ turnIndex, files });
		}
		loaded.sort((a, b) => a.turnIndex - b.turnIndex);
		turns = loaded;
		currentTurnIndex = loaded.length > 0 ? loaded[loaded.length - 1].turnIndex : -1;
		pruneTurns();
	} catch {
		// reload failures are non-fatal — start empty
	}
}

function getTurnDir(turnIndex: number): string {
	return join(ROLLBACK_BASE, sessionId, `turn-${turnIndex}`);
}

function cleanupTurnFiles(turn: TurnSnapshots): void {
	try {
		const dir = getTurnDir(turn.turnIndex);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

export interface RollbackResult {
	restored: string[];
	deleted: string[];
}

/**
 * Restore the newest NON-EMPTY turn's snapshots, drop it (and any empty turns
 * on top of it), and return what actually happened. Files the agent created
 * with edit/write are deleted in every capture mode; files created outside
 * tools (tree scope) are deleted only under hybrid/shadow-git.
 */
export function rollbackLastTurn(): RollbackResult {
	const empty: RollbackResult = { restored: [], deleted: [] };
	if (!isRollbackEnabled()) return empty;

	while (turns.length > 0 && turns[turns.length - 1].files.size === 0) {
		const skipped = turns.pop();
		if (skipped) cleanupTurnFiles(skipped);
	}
	if (turns.length === 0) return empty;

	const turn = turns[turns.length - 1];
	const capture = settingsManager?.getRollbackCapture() ?? "copies";
	const restored: string[] = [];
	const deleted: string[] = [];

	for (const [absPath, snap] of turn.files) {
		try {
			if (snap.existed && snap.content) {
				mkdirSync(dirname(absPath), { recursive: true });
				writeFileSync(absPath, snap.content);
				restored.push(absPath);
			} else if (!snap.existed) {
				const shouldDelete = snap.createdByTool || capture === "hybrid" || capture === "shadow-git";
				if (shouldDelete && existsSync(absPath)) {
					unlinkSync(absPath);
					deleted.push(absPath);
				}
			}
			// existed but content unreadable — skip
		} catch {
			// individual file restore failures are non-fatal
		}
	}

	cleanupTurnFiles(turn);
	turns.pop();

	return { restored, deleted };
}

export function getRollbackStatus(): { enabled: boolean; turns: number; files: number } {
	return {
		enabled: isRollbackEnabled(),
		turns: turns.length,
		files: turns.reduce((sum, t) => sum + t.files.size, 0),
	};
}

/** Clear all rollback state + this session's snapshot dir (called on session replace). */
export function clearRollback(): void {
	for (const turn of turns) {
		cleanupTurnFiles(turn);
	}
	try {
		const sessionDir = join(ROLLBACK_BASE, sessionId);
		if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	turns = [];
	currentTurnIndex = -1;
	sessionForceEnabled = false;
}

function snapFileName(absPath: string): string {
	return `${createHash("sha1").update(absPath).digest("hex")}.snap`;
}
