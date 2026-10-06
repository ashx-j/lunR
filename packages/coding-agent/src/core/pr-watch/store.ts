import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { SessionOwnership, writeSessionJson } from "../session-ownership.ts";
import { parsePrWatchFile } from "./persistence-schema.ts";
import type { PrWatchFile } from "./types.ts";

export function canonicalPrWatchProject(cwd: string): string {
	const path = existsSync(cwd) ? realpathSync.native(cwd) : resolve(cwd);
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** A separate session lease also covers in-memory sessions and duplicate extension clients. */
export class PrWatchStore {
	private readonly file: string;
	private readonly ownership: SessionOwnership;
	readonly sessionId: string;
	readonly project: string;
	constructor(root: string, sessionId: string, project: string) {
		this.sessionId = sessionId;
		this.project = project;
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const key = createHash("sha256").update(sessionId).digest("hex");
		this.file = join(root, `${key}.json`);
		this.ownership = new SessionOwnership(this.file);
		this.ownership.bindSession(sessionId);
	}

	load(): PrWatchFile {
		this.ownership.assert();
		if (!existsSync(this.file)) return { version: 1, sessionId: this.sessionId, project: this.project, watches: [] };
		const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
		return parsePrWatchFile(value, this.sessionId, this.project);
	}

	save(value: PrWatchFile): void {
		this.ownership.assert();
		writeSessionJson(this.file, value);
	}

	close(): void {
		this.ownership.release();
	}
}
