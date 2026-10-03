import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { getSessionsDir } from "../config.ts";
import { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

function canonicalDirectory(directory: string, allowMissing = false): string | undefined {
	try {
		return realpathSync(directory);
	} catch {
		if (!allowMissing) return undefined;
		try {
			// A dangling link exists and must not be treated as a missing directory.
			lstatSync(directory);
			return undefined;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return undefined;
		}
		try {
			// The standard sessions root may not exist when all storage is custom.
			return join(realpathSync(dirname(directory)), basename(directory));
		} catch {
			return undefined;
		}
	}
}

function containsDirectory(root: string, directory: string): boolean {
	if (process.platform === "win32") {
		root = root.toLowerCase();
		directory = directory.toLowerCase();
	}
	const path = relative(root, directory);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Global maintenance keeps its own policy; approved project policy applies only to its configured tree. */
export function getSessionRetentionTargets(
	globalSettings: SettingsManager,
	runtimeSettings: SettingsManager,
	explicitSessionDir?: string,
): { directory: string; days: number }[] {
	const globalDirectory = canonicalDirectory(getSessionsDir(), true);
	if (!globalDirectory) return [];
	const globalDays = globalSettings.getSessionRetentionDays();
	const targets = [{ directory: globalDirectory, days: globalDays }];
	const configuredDirectory = explicitSessionDir ?? runtimeSettings.getSessionDir();
	const directory = configuredDirectory ? canonicalDirectory(configuredDirectory) : undefined;
	if (directory && relative(globalDirectory, directory) !== "") {
		const projectDirectory = runtimeSettings.getProjectSettings().sessionDir;
		const overlapsGlobal =
			containsDirectory(globalDirectory, directory) || containsDirectory(directory, globalDirectory);
		const usesProjectDirectory =
			runtimeSettings.isProjectTrusted() &&
			projectDirectory !== undefined &&
			!overlapsGlobal &&
			directory === canonicalDirectory(projectDirectory);
		targets.push({ directory, days: usesProjectDirectory ? runtimeSettings.getSessionRetentionDays() : globalDays });
	}
	return targets.filter(({ days }) => days > 0);
}

/** Replace the provisional manager only after a project directory is approved. */
export async function selectApprovedStartupSession(
	manager: SessionManager,
	directory: string | undefined,
	select?: () => Promise<SessionManager>,
): Promise<SessionManager> {
	const cwd = manager.getCwd();
	const sessionFile = manager.getSessionFile();
	const id = manager.getSessionId();
	manager.dispose();
	if (select) return select();
	return sessionFile
		? SessionManager.open(sessionFile, directory, cwd)
		: SessionManager.create(cwd, directory, { id });
}
