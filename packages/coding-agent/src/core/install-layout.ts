/**
 * Binary install prefix metadata. Lives at getAgentDir()/install-layout.json,
 * never under <prefix>/agent. --prefix relocates versions/ + bin/ only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { writeJsonFileAtomic } from "../utils/json.ts";

export interface InstallLayoutFile {
	schemaVersion: 1;
	prefix: string;
	method: "binary";
	argv0: string;
	version: string;
}

export function defaultInstallPrefix(): string {
	return join(homedir(), ".lunr");
}

export function installLayoutPath(): string {
	return join(getAgentDir(), "install-layout.json");
}

export function loadInstallLayout(): InstallLayoutFile | undefined {
	const path = installLayoutPath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		if (raw.schemaVersion !== 1) return undefined;
		if (typeof raw.prefix !== "string" || typeof raw.argv0 !== "string" || typeof raw.version !== "string") {
			return undefined;
		}
		return {
			schemaVersion: 1,
			prefix: raw.prefix,
			method: "binary",
			argv0: raw.argv0,
			version: raw.version,
		};
	} catch {
		return undefined;
	}
}

export function saveInstallLayout(file: InstallLayoutFile): void {
	writeJsonFileAtomic(installLayoutPath(), file);
}

/** LUNR_PREFIX → install-layout.json → default ~/.lunr */
export function resolveInstallPrefix(): string {
	const env = process.env.LUNR_PREFIX?.trim();
	if (env) return env;
	return loadInstallLayout()?.prefix ?? defaultInstallPrefix();
}
