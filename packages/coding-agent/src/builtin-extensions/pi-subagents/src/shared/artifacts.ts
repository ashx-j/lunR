import * as fs from "node:fs";
import * as path from "node:path";
import { securePrivateDir } from "../../../../utils/private-dir.ts";
import { TEMP_ARTIFACTS_DIR, TEMP_ROOT_DIR, type ArtifactPaths } from "./types.ts";
import { getAgentDir } from "./utils.ts";
const CLEANUP_MARKER_FILE = ".last-cleanup";
const ARTIFACTS_DIR_NAME = "subagent-artifacts";

/**
 * Where a run keeps its task, output copy, transcript and metadata, where relative `output` files land
 * (`outputs/<runId>`) and where a sync chain works (`chain-runs/<runId>`): next to the parent's session
 * in the profile, or the private temp tree without one. Never the project, so read-only runs write
 * nothing there. Old project `.pi-subagents/` dirs stay as they are.
 */
export function getArtifactsDir(sessionFile: string | null): string {
	if (sessionFile) {
		const sessionDir = path.dirname(sessionFile);
		return path.join(sessionDir, ARTIFACTS_DIR_NAME);
	}
	return TEMP_ARTIFACTS_DIR;
}

export function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths {
	const suffix = index !== undefined ? `_${index}` : "";
	const safeAgent = agent.replace(/[^\w.-]/g, "_");
	const base = `${runId}_${safeAgent}${suffix}`;
	return {
		inputPath: path.join(artifactsDir, `${base}_input.md`),
		outputPath: path.join(artifactsDir, `${base}_output.md`),
		jsonlPath: path.join(artifactsDir, `${base}.jsonl`),
		transcriptPath: path.join(artifactsDir, `${base}_transcript.jsonl`),
		metadataPath: path.join(artifactsDir, `${base}_meta.json`),
	};
}

const securedArtifactDirs = new Set<string>();

/**
 * Creates an artifacts dir as a 0700 tree only this user can read: transcripts hold the user's code and
 * prompts, and the temp one has a fixed name anyone could create first. Checked once per process.
 */
export function ensureArtifactsDir(dir: string): void {
	if (securedArtifactDirs.has(dir)) return;
	if (dir === TEMP_ARTIFACTS_DIR) securePrivateDir(TEMP_ROOT_DIR, false);
	else fs.mkdirSync(path.dirname(dir), { recursive: true });
	securePrivateDir(dir);
	securedArtifactDirs.add(dir);
}

/** True for a path inside an artifacts dir, whose files and dirs lunR creates private. */
export function isArtifactsPath(filePath: string): boolean {
	const resolved = path.resolve(filePath);
	return resolved.startsWith(`${TEMP_ARTIFACTS_DIR}${path.sep}`) || resolved.split(path.sep).includes(ARTIFACTS_DIR_NAME);
}

export function writeArtifact(filePath: string, content: string): void {
	fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
}

export function writeMetadata(filePath: string, metadata: object): void {
	fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function appendJsonl(filePath: string, line: string): void {
	fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
}

export function cleanupOldArtifacts(dir: string, maxAgeDays: number): void {
	// A symlink or another user's dir at this fixed name would point the deletes below elsewhere.
	const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
	const uid = process.getuid?.();
	if (!dirStat?.isDirectory() || (uid !== undefined && dirStat.uid !== uid)) return;

	const markerPath = path.join(dir, CLEANUP_MARKER_FILE);
	const now = Date.now();

	if (fs.existsSync(markerPath)) {
		const stat = fs.statSync(markerPath);
		if (now - stat.mtimeMs < 24 * 60 * 60 * 1000) return;
	}

	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const cutoff = now - maxAgeMs;

	for (const file of fs.readdirSync(dir)) {
		if (file === CLEANUP_MARKER_FILE) continue;
		const filePath = path.join(dir, file);
		try {
			const stat = fs.statSync(filePath);
			if (stat.mtimeMs < cutoff) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Artifact cleanup is best-effort housekeeping. Skip files that disappear
			// or become unreadable while scanning so one bad entry does not block the rest.
		}
	}

	fs.writeFileSync(markerPath, String(now), { mode: 0o600 });
}

export function cleanupAllArtifactDirs(maxAgeDays: number): void {
	cleanupOldArtifacts(TEMP_ARTIFACTS_DIR, maxAgeDays);

	const sessionsBase = path.join(getAgentDir(), "sessions");
	if (!fs.existsSync(sessionsBase)) return;

	let dirs: string[];
	try {
		dirs = fs.readdirSync(sessionsBase);
	} catch {
		// Session artifact cleanup is best-effort. If the sessions root cannot be read,
		// skip cleanup instead of failing extension startup.
		return;
	}

	for (const dir of dirs) {
		const artifactsDir = path.join(sessionsBase, dir, "subagent-artifacts");
		try {
			cleanupOldArtifacts(artifactsDir, maxAgeDays);
		} catch {
			// Session cleanup is best-effort. Keep going so one unreadable session dir
			// does not block cleanup for the rest.
		}
	}
}
