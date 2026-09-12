/**
 * Published-install version check against the npm registry for @ashx-j/lunr.
 * Workspace checkouts (PACKAGE_NAME !== NPM_CLI_PACKAGE) never nag or self-update.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gt } from "semver";
import { NPM_CLI_PACKAGE, PACKAGE_NAME } from "../config.ts";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_TIMEOUT_MS = 4000;
export const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_CLI_PACKAGE}/latest`;

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

export function isPublishedInstall(
	packageName: string = PACKAGE_NAME,
	npmName: string = NPM_CLI_PACKAGE,
): boolean {
	return packageName === npmName;
}

export function updateCheckPath(agentDir: string): string {
	return join(agentDir, "update-check.json");
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

async function fetchLatest(fetchImpl: typeof fetch): Promise<string | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
	try {
		const response = await fetchImpl(NPM_LATEST_URL, {
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
}): Promise<UpdateCheckResult | undefined> {
	if (options.offline) return undefined;
	if (!(options.published ?? isPublishedInstall())) return undefined;

	const now = options.now ?? Date.now();
	const path = updateCheckPath(options.agentDir);
	let record = existsSync(path) ? readRecord(path) : undefined;
	const stale = !record || now - record.checkedAt >= UPDATE_CHECK_TTL_MS || options.force;
	if (stale) {
		const latest = await fetchLatest(options.fetchImpl ?? fetch);
		if (!latest) return record ? toResult(options.currentVersion, record, false) : undefined;
		record = { checkedAt: now, latest, notifiedVersion: record?.notifiedVersion };
		try {
			writeRecord(path, record);
		} catch {
			// Cache write is best-effort.
		}
	}

	if (!record) return undefined;
	return toResult(options.currentVersion, record, true);
}

function isNewer(latest: string, current: string): boolean {
	try {
		return gt(latest, current);
	} catch {
		return false;
	}
}

function toResult(current: string, record: UpdateCheckRecord, allowNotice: boolean): UpdateCheckResult {
	const newer = isNewer(record.latest, current);
	const notice =
		allowNotice && newer && record.notifiedVersion !== record.latest
			? `lunR ${record.latest} is available. Run lunr update.`
			: undefined;
	return { latest: record.latest, current, newer, notice };
}

/** Persist that we already showed the TUI notice for this latest version. */
export function markUpdateNotified(agentDir: string, latest: string): void {
	const path = updateCheckPath(agentDir);
	const record = existsSync(path) ? readRecord(path) : undefined;
	if (!record) return;
	record.notifiedVersion = latest;
	try {
		writeRecord(path, record);
	} catch {
		// ignore
	}
}
