/**
 * lunR: rollback service — pre-edit file snapshots for /rollback.
 *
 * Captures pre-write file content before edit/write tools mutate files, keyed
 * by user-turn. `/rollback` restores the newest turn's snapshots and then
 * reuses the existing /undo navigateTree logic to rewind the conversation.
 *
 * Capture modes (setting `rollbackCapture`):
 *  - copies:  snapshot pre-write content to disk; restore = write back.
 *  - hybrid:  copies + on restore also delete files the agent created in that turn.
 *  - shadow-git: hidden git repo (deferred — falls back to copies with a warning).
 *
 * Scope (setting `rollbackScope`):
 *  - tools: only edit/write tool changes.
 *  - tree:  also catches bash side-effects via `git status --porcelain` at turn
 *           boundaries (skipped with a one-time warning when cwd is not a repo).
 *
 * State is in-memory for the session (snapshots live on disk under
 * `~/.lunr/rollback/<session-id>/<turn-n>/`). Turn granularity = one user
 * message → agent_end. Retention prunes beyond `rollbackTurns` turns.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

const ROLLBACK_BASE = join(homedir(), ".lunr", "rollback");

let sessionForceEnabled = false;
let settingsManager: SettingsManager | undefined;
let sessionId = "default";
let turns: TurnSnapshots[] = [];
let currentTurnIndex = -1;
let gitWarningShown = false;

export function initRollback(sm: SettingsManager, sid: string): void {
	settingsManager = sm;
	sessionId = sid;
	turns = [];
	currentTurnIndex = -1;
	sessionForceEnabled = false;
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

/** Begin a new turn: push a new snapshot map, prune old turns beyond retention. */
export function beginTurn(): void {
	if (!isRollbackEnabled()) return;
	currentTurnIndex++;
	turns.push({ turnIndex: currentTurnIndex, files: new Map() });

	const maxTurns = settingsManager?.getRollbackTurns() ?? 2;
	while (turns.length > maxTurns) {
		const old = turns.shift();
		if (old) cleanupTurnFiles(old);
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

/** Scan for bash side-effects at turn boundary (tree scope only). */
export function captureTreeChanges(cwd: string): void {
	if (!isRollbackEnabled()) return;
	if (settingsManager?.getRollbackScope() !== "tree") return;
	if (currentTurnIndex < 0 || turns.length === 0) return;
	const turn = turns[turns.length - 1];
	if (!turn) return;

	// Use git status --porcelain when cwd is a repo; else skip with one-time warning.
	try {
		const result = spawnSync("git", ["status", "--porcelain", "-z"], { cwd, encoding: "utf8", timeout: 5000 });
		if (result.status !== null && result.stdout) {
			const entries = result.stdout.split("\0").filter((e) => e.length > 0);
			for (const entry of entries) {
				// porcelain format: XY <path>  (first 2 chars = status, then space, then path)
				const path = entry.slice(3);
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
	} catch {
		if (!gitWarningShown) {
			gitWarningShown = true;
			// tree scope needs a git repo for diffing; skip silently otherwise
		}
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
		manifest[absPath] = { existed: snap.existed, createdByTool: snap.createdByTool };
		if (snap.content) {
			const hash = simpleHash(absPath + snap.content.length);
			writeFileSync(join(turnDir, `${hash}.snap`), snap.content);
			manifest[absPath].snapFile = `${hash}.snap`;
		}
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	} catch {
		// disk persistence failures are non-fatal
	}
}

function readManifest(path: string): Record<string, { existed: boolean; createdByTool: boolean; snapFile?: string }> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
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

/** Restore the newest turn's snapshots, drop it, and return the result. */
export function rollbackLastTurn(): RollbackResult {
	if (!isRollbackEnabled()) return { restored: [], deleted: [] };
	if (turns.length === 0) return { restored: [], deleted: [] };

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
			} else if (!snap.existed && snap.createdByTool) {
				// File was created by the agent — delete it (hybrid mode)
				if (capture === "hybrid" || capture === "shadow-git") {
					if (existsSync(absPath)) {
						unlinkSync(absPath);
						deleted.push(absPath);
					}
				} else {
					// copies mode: restore to empty if it didn't exist
					if (existsSync(absPath)) {
						// leave it — copies mode doesn't delete created files
					}
				}
			} else if (snap.existed && !snap.content) {
				// existed but content unreadable — skip
			}
		} catch {
			// individual file restore failures are non-fatal
		}
	}

	cleanupTurnFiles(turn);
	turns.pop();

	return { restored, deleted: capture === "hybrid" || capture === "shadow-git" ? deleted : [] };
}

export function getRollbackStatus(): { enabled: boolean; turns: number; files: number } {
	return {
		enabled: isRollbackEnabled(),
		turns: turns.length,
		files: turns.reduce((sum, t) => sum + t.files.size, 0),
	};
}

/** Clear all rollback state (called on session replace). */
export function clearRollback(): void {
	for (const turn of turns) {
		cleanupTurnFiles(turn);
	}
	turns = [];
	currentTurnIndex = -1;
	sessionForceEnabled = false;
}

function simpleHash(input: string): string {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}
