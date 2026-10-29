/**
 * Legacy install-time feature file, ~/.lunr/agent/install-features.json (getAgentDir()).
 * The browser setting still reads an old explicit `features.browser` choice from it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, VERSION } from "../config.ts";

export interface InstalledFeatureState {
	enabled: boolean;
	options: Record<string, boolean | string | number>;
}

export interface InstallFeaturesFile {
	schemaVersion: 1;
	installerVersion: string;
	installMethod: "binary";
	installedAt: string;
	updatedAt: string;
	features: Record<string, InstalledFeatureState>;
}

export function installFeaturesPath(): string {
	return join(getAgentDir(), "install-features.json");
}

function emptyFile(now = new Date().toISOString()): InstallFeaturesFile {
	return {
		schemaVersion: 1,
		installerVersion: VERSION,
		installMethod: "binary",
		installedAt: now,
		updatedAt: now,
		features: {},
	};
}

function sanitizeState(raw: unknown): InstalledFeatureState | undefined {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled !== "boolean") return undefined;
	const options: Record<string, boolean | string | number> = {};
	if (r.options != null && typeof r.options === "object" && !Array.isArray(r.options)) {
		for (const [k, v] of Object.entries(r.options as Record<string, unknown>)) {
			if (typeof v === "boolean" || typeof v === "string" || typeof v === "number") {
				options[k] = v;
			}
		}
	}
	return { enabled: r.enabled, options };
}

function sanitizeFile(raw: unknown): InstallFeaturesFile | undefined {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== 1) return undefined;
	const features: Record<string, InstalledFeatureState> = {};
	if (r.features != null && typeof r.features === "object" && !Array.isArray(r.features)) {
		for (const [id, state] of Object.entries(r.features as Record<string, unknown>)) {
			const sanitized = sanitizeState(state);
			if (sanitized) features[id] = sanitized;
		}
	}
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		installerVersion: typeof r.installerVersion === "string" ? r.installerVersion : VERSION,
		installMethod: "binary",
		installedAt: typeof r.installedAt === "string" ? r.installedAt : now,
		updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
		features,
	};
}

export function loadInstallFeatures(): InstallFeaturesFile {
	const path = installFeaturesPath();
	if (!existsSync(path)) {
		return emptyFile();
	}
	try {
		const parsed = sanitizeFile(JSON.parse(readFileSync(path, "utf-8")));
		return parsed ?? emptyFile();
	} catch {
		return emptyFile();
	}
}

export function appendInstallLog(line: string): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = join(dir, "install.log");
		writeFileSync(path, `${new Date().toISOString()} ${line}\n`, { encoding: "utf-8", flag: "a" });
	} catch {
		// best-effort
	}
}

export const PRODUCT_UNINSTALL_FLAGS = new Set(["--purge", "--yes", "-y"]);

/** Product uninstall only when every remaining argv is empty or a product flag. */
export function isProductUninstallArgv(rest: string[]): boolean {
	return rest.every((arg) => PRODUCT_UNINSTALL_FLAGS.has(arg));
}
