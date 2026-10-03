import { resolve } from "node:path";
import { getSessionsDir } from "../config.ts";
import { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** Global maintenance keeps its own policy; approved project policy applies only to its configured tree. */
export function getSessionRetentionTargets(
	globalSettings: SettingsManager,
	runtimeSettings: SettingsManager,
	explicitSessionDir?: string,
): { directory: string; days: number }[] {
	const globalDirectory = getSessionsDir();
	const globalDays = globalSettings.getSessionRetentionDays();
	const targets = [{ directory: globalDirectory, days: globalDays }];
	const directory = explicitSessionDir ?? runtimeSettings.getSessionDir();
	if (directory && resolve(directory) !== resolve(globalDirectory)) {
		const projectDirectory = runtimeSettings.getProjectSettings().sessionDir;
		const usesProjectDirectory =
			runtimeSettings.isProjectTrusted() &&
			projectDirectory !== undefined &&
			resolve(directory) === resolve(projectDirectory);
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
