import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface SessionOwner {
	version: 1;
	file: string;
	generation: string;
	pid: number;
	host: string;
	instance: string;
	sessionId?: string;
}
const instance = randomUUID();

export class SessionOwnershipError extends Error {
	readonly file: string;
	constructor(
		file: string,
		message = "Session is owned by another runtime. Request a transfer or close its owner first.",
	) {
		super(`${message} ${file}`);
		this.name = "SessionOwnershipError";
		this.file = file;
	}
}

export function canonicalSessionPath(file: string): string {
	const absolute = resolve(file);
	let canonical: string;
	if (existsSync(absolute)) canonical = realpathSync.native(absolute);
	else {
		const parent = dirname(absolute);
		canonical = parent === absolute ? absolute : join(canonicalSessionPath(parent), basename(absolute));
	}
	return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function sessionOwnershipDirectory(file: string): string {
	return `${canonicalSessionPath(file)}.owner`;
}

export function readSessionOwner(file: string): SessionOwner | undefined {
	const directory = sessionOwnershipDirectory(file);
	if (!existsSync(directory)) return undefined;
	try {
		const value = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
		if (
			value.version === 1 &&
			value.file === canonicalSessionPath(file) &&
			typeof value.generation === "string" &&
			Number.isSafeInteger(value.pid) &&
			value.pid > 0 &&
			typeof value.host === "string" &&
			typeof value.instance === "string"
		)
			return value;
	} catch {}
	throw new SessionOwnershipError(file, "Session owner is incomplete or unknown; automatic takeover is unsafe.");
}

export function isSessionOwnerDead(owner: SessionOwner): boolean {
	if (owner.host !== hostname()) return false;
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export function writeSessionJson(file: string, value: unknown): void {
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
		renameSync(temp, file);
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}

export class SessionOwnership {
	readonly owner: SessionOwner;
	private released = false;
	private readonly directory: string;
	constructor(file: string) {
		file = canonicalSessionPath(file);
		if (existsSync(file) && statSync(file).nlink > 1)
			throw new SessionOwnershipError(file, "Hard-linked sessions cannot be owned safely. Use a separate copy.");
		this.directory = sessionOwnershipDirectory(file);
		this.owner = { version: 1, file, generation: randomUUID(), pid: process.pid, host: hostname(), instance };
		mkdirSync(dirname(file), { recursive: true });
		try {
			mkdirSync(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const old = readSessionOwner(file);
			if (!old || !isSessionOwnerDead(old)) throw new SessionOwnershipError(file);
			// Serialize dead-owner cleanup. Never infer death from elapsed time or a missing heartbeat.
			const recovery = `${this.directory}.recovery`;
			try {
				writeFileSync(recovery, JSON.stringify(this.owner), { flag: "wx", mode: 0o600 });
			} catch {
				throw new SessionOwnershipError(
					file,
					"Session recovery is already in progress or requires manual inspection.",
				);
			}
			try {
				const current = readSessionOwner(file);
				if (current?.generation !== old.generation || !isSessionOwnerDead(current))
					throw new SessionOwnershipError(file);
				unlinkSync(join(this.directory, "owner.json"));
				rmdirSync(this.directory);
				try {
					mkdirSync(this.directory);
				} catch {
					throw new SessionOwnershipError(file);
				}
			} finally {
				unlinkSync(recovery);
			}
		}
		writeSessionJson(join(this.directory, "owner.json"), this.owner);
	}
	bindSession(sessionId: string): void {
		this.assert();
		this.owner.sessionId = sessionId;
		writeSessionJson(join(this.directory, "owner.json"), this.owner);
	}

	assert(): void {
		if (existsSync(this.owner.file) && statSync(this.owner.file).nlink > 1)
			throw new SessionOwnershipError(this.owner.file, "Session acquired a hard-link alias; writes are blocked.");
		if (this.released || readSessionOwner(this.owner.file)?.generation !== this.owner.generation) {
			throw new SessionOwnershipError(
				this.owner.file,
				"This runtime no longer owns the session. Reclaim or reopen it before continuing.",
			);
		}
	}
	release(): void {
		if (this.released) return;
		this.assert();
		this.released = true;
		const releasedDirectory = `${this.directory}.released-${this.owner.generation}`;
		renameSync(this.directory, releasedDirectory);
		unlinkSync(join(releasedDirectory, "owner.json"));
		rmdirSync(releasedDirectory);
	}
}
