import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { assertOwnedPath } from "./runtime.ts";

export class DesktopLease {
	private readonly identity = randomUUID();
	private owned = false;
	private tail: Promise<unknown> = Promise.resolve();
	private closed = false;
	private readonly controller = new AbortController();
	get signal(): AbortSignal {
		return this.controller.signal;
	}
	private readonly directory: string;
	constructor(directory = join(userInfo().homedir, ".lunr", "desktop")) {
		this.directory = directory;
	}

	private async owner(): Promise<{ pid: number; identity: string; processes: number[] } | undefined> {
		try {
			const value: unknown = JSON.parse(await readFile(join(this.directory, "workflow-owner.json"), "utf8"));
			if (
				!value ||
				typeof value !== "object" ||
				!("pid" in value) ||
				typeof value.pid !== "number" ||
				!Number.isInteger(value.pid) ||
				value.pid < 1 ||
				!("identity" in value) ||
				typeof value.identity !== "string"
			)
				throw new Error("Invalid desktop owner record; refusing takeover.");
			const processes = "processes" in value ? value.processes : [];
			if (!Array.isArray(processes) || !processes.every((pid) => Number.isInteger(pid) && pid > 0))
				throw new Error("Invalid runtime owner record; refusing takeover.");
			return { pid: value.pid, identity: value.identity, processes };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async withOwnerLock(operation: () => Promise<void>): Promise<void> {
		const release = await lockfile.lock(this.directory, {
			lockfilePath: join(this.directory, "workflow-acquire.lock"),
			retries: 0,
			stale: 10000,
		});
		try {
			await operation();
		} finally {
			await release();
		}
	}

	private async writeOwner(owner: { pid: number; identity: string; processes?: number[] }): Promise<void> {
		const temporary = join(this.directory, `workflow-owner-${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
			await rename(temporary, join(this.directory, "workflow-owner.json"));
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async acquire(): Promise<void> {
		await assertOwnedPath(this.directory);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await this.withOwnerLock(async () => {
			const owner = await this.owner();
			if (owner) {
				const alive = [owner.pid, ...owner.processes].some((pid) => {
					try {
						process.kill(pid, 0);
						return true;
					} catch (error) {
						return !(error instanceof Error && "code" in error && error.code === "ESRCH");
					}
				});
				if (alive)
					throw new Error(
						"Desktop busy: another lunR workflow owns this user's desktop. Retry only after it ends.",
					);
			}
			await this.writeOwner({ pid: process.pid, identity: this.identity });
			this.owned = true;
		});
	}

	async trackProcess(pid: number): Promise<void> {
		await this.withOwnerLock(async () => {
			const owner = await this.owner();
			if (!owner || owner.identity !== this.identity || !Number.isInteger(pid) || pid < 1)
				throw new Error("Cannot bind runtime to the desktop lease.");
			if (!owner.processes.includes(pid)) owner.processes.push(pid);
			await this.writeOwner(owner);
		});
	}

	run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const result = this.tail.then(async () => {
			if (this.closed) throw new Error("Desktop workflow ended. Start a new workflow and observe again.");
			signal?.throwIfAborted();
			if (!this.owned) await this.acquire();
			if ((await this.owner())?.identity !== this.identity) {
				this.closed = true;
				this.controller.abort(new Error("Desktop lease lost."));
				throw new Error("Desktop lease lost. Input refused.");
			}
			signal?.throwIfAborted();
			return operation();
		});
		this.tail = result.catch(() => undefined);
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.controller.abort();
		await this.tail;
		if (this.owned) {
			await this.withOwnerLock(async () => {
				if ((await this.owner())?.identity === this.identity) await rm(join(this.directory, "workflow-owner.json"));
			});
			this.owned = false;
		}
	}
}
