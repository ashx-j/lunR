/**
 * Published-install version check against the active stable or dev npm package.
 * Workspace checkouts (PACKAGE_NAME !== NPM_CLI_PACKAGE) never nag or self-update.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gt } from "semver";
import { APP_NAME, NPM_CLI_PACKAGE, PACKAGE_NAME, STABLE_NPM_CLI_PACKAGE } from "../config.ts";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 4000;

export function npmLatestUrl(packageName: string = NPM_CLI_PACKAGE): string {
	return `https://registry.npmjs.org/${packageName}/latest`;
}

export const NPM_LATEST_URL = npmLatestUrl();

export interface UpdateCheckRecord {
	checkedAt: number;
	latest: string;
	notifiedVersion?: string;
}

export interface UpdateCheckResult {
	latest: string;
	current: string;
	newer: boolean;
	notice?: string;
}

export function isPublishedInstall(packageName: string = PACKAGE_NAME, npmName: string = NPM_CLI_PACKAGE): boolean {
	return packageName === npmName;
}

export function updateCheckPath(agentDir: string, packageName: string = NPM_CLI_PACKAGE): string {
	return join(agentDir, packageName === STABLE_NPM_CLI_PACKAGE ? "update-check.json" : "update-check-dev.json");
}

function readRecord(path: string): UpdateCheckRecord | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as UpdateCheckRecord;
		if (typeof raw.checkedAt !== "number" || typeof raw.latest !== "string" || !raw.latest.trim()) {
			return undefined;
		}
		return {
			checkedAt: raw.checkedAt,
			latest: raw.latest.trim(),
			notifiedVersion: typeof raw.notifiedVersion === "string" ? raw.notifiedVersion : undefined,
		};
	} catch {
		return undefined;
	}
}

function writeRecord(path: string, record: UpdateCheckRecord): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function fetchLatest(fetchImpl: typeof fetch, packageName: string): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
	try {
		const response = await fetchImpl(npmLatestUrl(packageName), {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { version?: unknown };
		return typeof payload.version === "string" && payload.version.trim() ? payload.version.trim() : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

export async function checkForUpdate(options: {
	currentVersion: string;
	agentDir: string;
	now?: number;
	fetchImpl?: typeof fetch;
	published?: boolean;
	offline?: boolean;
	force?: boolean;
	packageName?: string;
	appName?: string;
}): Promise<UpdateCheckResult | undefined> {
	if (options.offline) return undefined;
	const packageName = options.packageName ?? NPM_CLI_PACKAGE;
	if (!(options.published ?? isPublishedInstall(PACKAGE_NAME, packageName))) return undefined;

	const now = options.now ?? Date.now();
	const path = updateCheckPath(options.agentDir, packageName);
	let record = existsSync(path) ? readRecord(path) : undefined;
	const stale = !record || now - record.checkedAt >= UPDATE_CHECK_TTL_MS || options.force;
	if (stale) {
		const latest = await fetchLatest(options.fetchImpl ?? fetch, packageName);
		if (!latest)
			return record ? toResult(options.currentVersion, record, false, options.appName ?? APP_NAME) : undefined;
		record = { checkedAt: now, latest, notifiedVersion: record?.notifiedVersion };
		try {
			writeRecord(path, record);
		} catch {
			// Cache write is best-effort.
		}
	}

	if (!record) return undefined;
	return toResult(options.currentVersion, record, true, options.appName ?? APP_NAME);
}

function isNewer(latest: string, current: string): boolean {
	try {
		return gt(latest, current);
	} catch {
		return false;
	}
}

function toResult(
	current: string,
	record: UpdateCheckRecord,
	allowNotice: boolean,
	appName: string,
): UpdateCheckResult {
	const newer = isNewer(record.latest, current);
	const displayName = appName === "lunr" ? "lunR" : appName;
	const notice =
		allowNotice && newer && record.notifiedVersion !== record.latest
			? `${displayName} ${record.latest} is available. Run ${appName} update.`
			: undefined;
	return { latest: record.latest, current, newer, notice };
}

/** Persist that we already showed the TUI notice for this latest version. */
export function markUpdateNotified(agentDir: string, latest: string, packageName: string = NPM_CLI_PACKAGE): void {
	const path = updateCheckPath(agentDir, packageName);
	const record = existsSync(path) ? readRecord(path) : undefined;
	if (!record) return;
	record.notifiedVersion = latest;
	try {
		writeRecord(path, record);
	} catch {
		// ignore
	}
}
