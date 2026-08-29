/**
 * lunR: rollback service — pre-edit file snapshots for /rollback.
 *
 * Captures pre-write file content before edit/write tools mutate files, keyed
 * by user-turn and session id. `/rollback` restores the newest non-empty turn's
 * snapshots and then rewinds the conversation via a session fork (persistent,
 * unlike /undo and /edit, which stay in the same session file).
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
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface Snapshot {
	existed: boolean;
	content?: Buffer;
	createdByTool: boolean;
}

interface TurnSnapshots {
	turnIndex: number;
	cwd?: string;
	files: Map<string, Snapshot>;
}

interface ManifestEntry {
	existed: boolean;
	createdByTool: boolean;
	snapFile?: string;
}

interface TurnManifest {
	cwd?: string;
	files: Record<string, ManifestEntry>;
}

const ROLLBACK_BASE = join(homedir(), ".lunr", "rollback");

interface RollbackContext {
	sessionId: string;
	settingsManager: SettingsManager | undefined;
	sessionForceEnabled: boolean;
	turns: TurnSnapshots[];
	currentTurnIndex: number;
	repoWarningShown: boolean;
	externalModWarningShown: boolean;
	/** Last cwd seen by beginTurn — reused by auto-started turns (mid-turn enable). */
	lastCwd?: string;
}

const contexts = new Map<string, RollbackContext>();
let lastSessionId: string | undefined;
let globalSettingsManager: SettingsManager | undefined;
let warningHandler: ((message: string) => void) | undefined;

/** Register a sink for one-time user-facing warnings (e.g. tree scope outside a git repo). */
export function setRollbackWarningHandler(handler: ((message: string) => void) | undefined): void {
	warningHandler = handler;
}

function createContext(sessionId: string): RollbackContext {
	return {
		sessionId,
		settingsManager: globalSettingsManager,
		sessionForceEnabled: false,
		turns: [],
		currentTurnIndex: -1,
		repoWarningShown: false,
		externalModWarningShown: false,
	};
}

function getContext(sessionId?: string): RollbackContext {
	const sid = sessionId ?? lastSessionId ?? "default";
	let ctx = contexts.get(sid);
	if (!ctx) {
		ctx = createContext(sid);
		contexts.set(sid, ctx);
	}
	return ctx;
}

export function initRollback(sm: SettingsManager, sid: string): void {
	globalSettingsManager = sm;
	lastSessionId = sid;
	contexts.set(sid, createContext(sid));
	const ctx = contexts.get(sid)!;
	ctx.settingsManager = sm;
	loadPersistedTurns(ctx);
}

export function isRollbackEnabled(sessionId?: string): boolean {
	const ctx = getContext(sessionId);
	return (ctx.settingsManager?.getRollbackEnabled() ?? false) || ctx.sessionForceEnabled;
}

/** Whether rollback is force-enabled for this session (e.g. by auto permission mode). */
export function isRollbackSessionForceEnabled(sessionId?: string): boolean {
	return getContext(sessionId).sessionForceEnabled;
}

export function enableRollbackForSession(sessionId?: string): void {
	getContext(sessionId).sessionForceEnabled = true;
}

export function disableRollbackForSession(sessionId?: string): void {
	getContext(sessionId).sessionForceEnabled = false;
}

function pruneTurns(ctx: RollbackContext): void {
	const maxTurns = ctx.settingsManager?.getRollbackTurns() ?? 2;
	while (ctx.turns.length > maxTurns) {
		const old = ctx.turns.shift();
		if (old) cleanupTurnFiles(ctx, old);
	}
}

/**
 * Begin a new turn: push a new snapshot map, prune old turns beyond retention.
 * When `cwd` is given and scope is `tree`, also capture the pre-turn baseline
 * (content of all currently dirty/untracked files) so bash side-effects can be
 * restored later.
 */
export function beginTurn(cwd?: string, sessionId?: string): void {
	const ctx = getContext(sessionId);
	if (!isRollbackEnabled(ctx.sessionId)) return;
	// lunr: remember the session cwd so auto-started turns (mid-turn enable) can
	// still be constrained by the allowed-roots check.
	if (cwd) ctx.lastCwd = cwd;
	ctx.currentTurnIndex++;
	const turn: TurnSnapshots = { turnIndex: ctx.currentTurnIndex, cwd, files: new Map() };
	ctx.turns.push(turn);
	pruneTurns(ctx);
	if (cwd && ctx.settingsManager?.getRollbackScope() === "tree") {
		captureTreeBaseline(ctx, cwd);
	}
}

/** Capture pre-write content for a file path, recording under the current turn. */
export function rollbackSnapshotBeforeWrite(absPath: string, sessionId?: string): void {
	const ctx = getContext(sessionId);
	if (!isRollbackEnabled(ctx.sessionId)) return;
	// lunr: auto-started turn inherits the last known cwd so restores stay
	// root-checked; without any recorded cwd the allowed roots still apply.
	if (ctx.currentTurnIndex < 0 || ctx.turns.length === 0) beginTurn(ctx.lastCwd, ctx.sessionId);
	const turn = ctx.turns[ctx.turns.length - 1];
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
		persistSnapshot(ctx, turn, absPath);
	} catch {
		// snapshot failures are non-fatal
	}
}

/**
 * Tree scope, turn START: snapshot the current (pre-turn) content of every
 * dirty/untracked file so modifications made during the turn can be restored.
 */
function captureTreeBaseline(ctx: RollbackContext, cwd: string): void {
	const turn = ctx.turns[ctx.turns.length - 1];
	if (!turn) return;
	const entries = gitPorcelain(ctx, cwd);
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
			persistSnapshot(ctx, turn, abs);
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
export function captureTreeChanges(cwd: string, sessionId?: string): void {
	const ctx = getContext(sessionId);
	if (!isRollbackEnabled(ctx.sessionId)) return;
	if (ctx.settingsManager?.getRollbackScope() !== "tree") return;
	if (ctx.currentTurnIndex < 0 || ctx.turns.length === 0) return;
	const turn = ctx.turns[ctx.turns.length - 1];
	if (!turn) return;

	const entries = gitPorcelain(ctx, cwd);
	if (!entries) return;
	for (const { status, path, source } of entries) {
		if (!path) continue;
		const abs = join(cwd, path);
		if (turn.files.has(abs)) continue; // already captured (baseline or tool snapshot)
		try {
			if (status === "??" || status.includes("R")) {
				// lunr: untracked now (or rename dest) and not in the baseline — created
				// during this turn (deleted on restore under hybrid/shadow-git).
				turn.files.set(abs, { existed: false, createdByTool: false });
				persistSnapshot(ctx, turn, abs);
				// lunr: rename source existed at HEAD and is gone now — restore its
				// HEAD content on rollback, like a tracked file deleted mid-turn.
				if (status.includes("R") && source) {
					const sourceAbs = join(cwd, source);
					if (!turn.files.has(sourceAbs)) {
						const headSrc = spawnSync("git", ["show", `HEAD:${source}`], {
							cwd,
							timeout: 5000,
							maxBuffer: 32 * 1024 * 1024,
						});
						if (!headSrc.error && headSrc.status === 0 && headSrc.stdout) {
							turn.files.set(sourceAbs, {
								existed: true,
								content: headSrc.stdout as Buffer,
								createdByTool: false,
							});
							persistSnapshot(ctx, turn, sourceAbs);
						}
					}
				}
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
				persistSnapshot(ctx, turn, abs);
			}
		} catch {
			// skip unreadable
		}
	}
}

/**
 * Run `git status --porcelain -z` and parse entries, or return undefined (with
 * a one-time warning) when cwd is not a repo / git fails. Rename/copy entries
 * carry their source path in a separate bare field — parsed into `source`.
 */
function gitPorcelain(
	ctx: RollbackContext,
	cwd: string,
): Array<{ status: string; path: string; source?: string }> | undefined {
	try {
		const result = spawnSync("git", ["status", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 5000 });
		if (result.error || result.status !== 0) {
			warnOnce(
				ctx,
				"Rollback tree scope: not a git repository (or git failed) — bash side-effects won't be captured.",
			);
			return undefined;
		}
		const fields = (result.stdout ?? "").split("\0").filter((f) => f.length > 0);
		const entries: Array<{ status: string; path: string; source?: string }> = [];
		for (let i = 0; i < fields.length; i++) {
			const field = fields[i];
			const status = field.slice(0, 2);
			const path = field.slice(3);
			let source: string | undefined;
			if (status.includes("R") || status.includes("C")) {
				// Rename/copy: the bare field after this entry is the source path.
				source = fields[i + 1];
				i++;
			}
			entries.push({ status, path, source });
		}
		return entries;
	} catch {
		warnOnce(ctx, "Rollback tree scope: not a git repository (or git failed) — bash side-effects won't be captured.");
		return undefined;
	}
}

function warnOnce(ctx: RollbackContext, message: string): void {
	if (ctx.repoWarningShown) return;
	ctx.repoWarningShown = true;
	try {
		warningHandler?.(message);
	} catch {
		// warning delivery is best-effort
	}
}

function persistSnapshot(ctx: RollbackContext, turn: TurnSnapshots, absPath: string): void {
	try {
		const snap = turn.files.get(absPath);
		if (!snap) return;
		const turnDir = getTurnDir(ctx, turn.turnIndex);
		mkdirSync(turnDir, { recursive: true });
		const manifestPath = join(turnDir, "manifest.json");
		const manifest = readManifest(manifestPath);
		const entry: ManifestEntry = { existed: snap.existed, createdByTool: snap.createdByTool };
		if (snap.content) {
			const snapFile = snapFileName(absPath);
			writeFileSync(join(turnDir, snapFile), snap.content);
			entry.snapFile = snapFile;
		}
		manifest.files[absPath] = entry;
		if (turn.cwd) manifest.cwd = turn.cwd;
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	} catch {
		// disk persistence failures are non-fatal
	}
}

function readManifest(path: string): TurnManifest {
	if (!existsSync(path)) return { files: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const files = (parsed as Record<string, unknown>).files;
			return {
				cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
				files:
					files && typeof files === "object" && !Array.isArray(files)
						? (files as Record<string, ManifestEntry>)
						: {},
			};
		}
		return { files: {} };
	} catch {
		return { files: {} };
	}
}

/** Reload persisted turns from disk (called by initRollback) so rollback survives restarts. */
function loadPersistedTurns(ctx: RollbackContext): void {
	try {
		const sessionDir = join(ROLLBACK_BASE, ctx.sessionId);
		if (!existsSync(sessionDir)) return;
		const loaded: TurnSnapshots[] = [];
		for (const dirName of readdirSync(sessionDir)) {
			const match = /^turn-(\d+)$/.exec(dirName);
			if (!match) continue;
			const turnIndex = Number(match[1]);
			const turnDir = join(sessionDir, dirName);
			const manifest = readManifest(join(turnDir, "manifest.json"));
			const files = new Map<string, Snapshot>();
			for (const [absPath, meta] of Object.entries(manifest.files)) {
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
			loaded.push({ turnIndex, cwd: manifest.cwd, files });
		}
		loaded.sort((a, b) => a.turnIndex - b.turnIndex);
		ctx.turns = loaded;
		ctx.currentTurnIndex = loaded.length > 0 ? loaded[loaded.length - 1].turnIndex : -1;
		pruneTurns(ctx);
	} catch {
		// reload failures are non-fatal — start empty
	}
}

function getTurnDir(ctx: RollbackContext, turnIndex: number): string {
	return join(ROLLBACK_BASE, ctx.sessionId, `turn-${turnIndex}`);
}

function cleanupTurnFiles(ctx: RollbackContext, turn: TurnSnapshots): void {
	try {
		const dir = getTurnDir(ctx, turn.turnIndex);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

export interface RollbackResult {
	restored: string[];
	deleted: string[];
	/** Number of turns consumed: the restored turn plus any empty turns skipped above it. */
	turnsConsumed: number;
}

/**
 * Restore the newest NON-EMPTY turn's snapshots, drop it (and any empty turns
 * on top of it), and return what actually happened. Files the agent created
 * with edit/write are deleted in every capture mode; files created outside
 * tools (tree scope) are deleted only under hybrid/shadow-git.
 */
function isPathUnderRoot(absPath: string, root: string): boolean {
	let normRoot = normalize(root).replace(/\\$/g, "");
	let normPath = normalize(absPath).replace(/\\$/g, "");
	// lunr: Windows drive-letter/directory casing differs by launch context and
	// resolve() preserves input casing — compare case-insensitively there.
	if (process.platform === "win32") {
		normRoot = normRoot.toLowerCase();
		normPath = normPath.toLowerCase();
	}
	return normPath === normRoot || normPath.startsWith(`${normRoot}/`) || normPath.startsWith(`${normRoot}\\`);
}

function isWithinAllowedRoots(absPath: string, turn: TurnSnapshots): boolean {
	if (!turn.cwd) return true; // no recorded cwd: cannot validate, allow (tests / legacy)
	const roots = [
		ROLLBACK_BASE,
		join(homedir(), CONFIG_DIR_NAME), // lunr: agent settings / cron jobs.json live under the config dir
		// lunr: simple-memory lives next to the lunr agent dir (~/.lunr/simple-memory)
		join(dirname(getAgentDir()), "simple-memory"),
		resolve(turn.cwd),
	];
	return roots.some((root) => isPathUnderRoot(absPath, root));
}

function warnExternalModification(ctx: RollbackContext, message: string): void {
	if (ctx.externalModWarningShown || !warningHandler) return;
	ctx.externalModWarningShown = true;
	try {
		warningHandler(message);
	} catch {
		// warning delivery is best-effort
	}
}

/** Count how many turns a rollback would consume (trailing empty turns + the newest non-empty one). */
export function peekRollbackTurnsConsumed(sessionId?: string): number {
	const ctx = getContext(sessionId);
	if (!isRollbackEnabled(ctx.sessionId)) return 0;
	if (ctx.turns.length === 0) return 0;
	let consumed = 0;
	for (let i = ctx.turns.length - 1; i >= 0; i--) {
		consumed++;
		if (ctx.turns[i].files.size > 0) break;
	}
	return consumed;
}

export function rollbackLastTurn(sessionId?: string): RollbackResult {
	const ctx = getContext(sessionId);
	const empty: RollbackResult = { restored: [], deleted: [], turnsConsumed: 0 };
	if (!isRollbackEnabled(ctx.sessionId)) return empty;

	let turnsConsumed = 0;
	while (ctx.turns.length > 0 && ctx.turns[ctx.turns.length - 1].files.size === 0) {
		const skipped = ctx.turns.pop();
		if (skipped) {
			cleanupTurnFiles(ctx, skipped);
			turnsConsumed++;
		}
	}
	if (ctx.turns.length === 0) return empty;
	turnsConsumed++;

	const turn = ctx.turns[ctx.turns.length - 1];
	const capture = ctx.settingsManager?.getRollbackCapture() ?? "copies";
	const restored: string[] = [];
	const deleted: string[] = [];

	for (const [absPath, snap] of turn.files) {
		try {
			if (!isWithinAllowedRoots(absPath, turn)) {
				warnExternalModification(
					ctx,
					`Rollback skipped ${absPath}: outside the session working directory or lunR config dir.`,
				);
				continue;
			}

			if (snap.existed && snap.content) {
				// For tree-scope baseline snapshots, skip the write if the file is
				// already identical to the snapshot (no actual change occurred during the
				// turn). Tool snapshots are always written so /rollback reports them.
				if (!snap.createdByTool && existsSync(absPath)) {
					const current = readFileSync(absPath);
					if (current.equals(snap.content)) continue;
				}
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

	cleanupTurnFiles(ctx, turn);
	ctx.turns.pop();

	return { restored, deleted, turnsConsumed };
}

export function getRollbackStatus(sessionId?: string): { enabled: boolean; turns: number; files: number } {
	const ctx = getContext(sessionId);
	return {
		enabled: isRollbackEnabled(ctx.sessionId),
		turns: ctx.turns.length,
		files: ctx.turns.reduce((sum, t) => sum + t.files.size, 0),
	};
}

/**
 * lunr: carry a session's rollback state across a fork — re-key the in-memory
 * context and move the on-disk dir to the forked session's id. No-op when the
 * old session has no state. Fork teardown deliberately skips clearRollback so
 * this can run right after (see interactive-mode beforeSessionInvalidate).
 */
export function migrateRollbackSession(oldSessionId: string, newSessionId: string): void {
	if (oldSessionId === newSessionId) return;
	const ctx = contexts.get(oldSessionId);
	if (ctx) {
		contexts.delete(oldSessionId);
		ctx.sessionId = newSessionId;
		contexts.set(newSessionId, ctx);
	}
	try {
		const oldDir = join(ROLLBACK_BASE, oldSessionId);
		const newDir = join(ROLLBACK_BASE, newSessionId);
		if (existsSync(oldDir)) {
			if (existsSync(newDir)) rmSync(newDir, { recursive: true, force: true });
			try {
				renameSync(oldDir, newDir);
			} catch {
				// Cross-device or locked-dir fallback: copy then delete.
				cpSync(oldDir, newDir, { recursive: true });
				rmSync(oldDir, { recursive: true, force: true });
			}
		}
	} catch {
		// migration failures are non-fatal — in-memory state was still re-keyed
	}
}

/** Clear rollback state for a session (or all sessions when no id is passed). */
export function clearRollback(sessionId?: string): void {
	if (sessionId === undefined) {
		for (const ctx of contexts.values()) {
			for (const turn of ctx.turns) {
				cleanupTurnFiles(ctx, turn);
			}
			try {
				const sessionDir = join(ROLLBACK_BASE, ctx.sessionId);
				if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
		contexts.clear();
		return;
	}

	const ctx = contexts.get(sessionId);
	if (!ctx) return;
	for (const turn of ctx.turns) {
		cleanupTurnFiles(ctx, turn);
	}
	try {
		const sessionDir = join(ROLLBACK_BASE, sessionId);
		if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
	contexts.delete(sessionId);
}

function snapFileName(absPath: string): string {
	return `${createHash("sha1").update(absPath).digest("hex")}.snap`;
}
