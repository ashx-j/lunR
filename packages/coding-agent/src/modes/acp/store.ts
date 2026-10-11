import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

export interface AcpSessionRecord {
	id: string;
	cwd: string;
	sessionFile: string;
	title?: string;
	updatedAt: string;
}

// one atomic record per native session avoids pi-acp's shared session-map write races.
export class AcpSessionStore {
	private readonly directory: string;
	constructor(directory = join(getAgentDir(), "acp", "sessions")) {
		this.directory = directory;
	}

	get(id: string): AcpSessionRecord | undefined {
		if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
		try {
			const record: unknown = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8"));
			if (
				!record ||
				typeof record !== "object" ||
				!("id" in record) ||
				record.id !== id ||
				!("cwd" in record) ||
				typeof record.cwd !== "string" ||
				!("sessionFile" in record) ||
				typeof record.sessionFile !== "string" ||
				!("updatedAt" in record) ||
				typeof record.updatedAt !== "string"
			)
				return undefined;
			return {
				id,
				cwd: record.cwd,
				sessionFile: record.sessionFile,
				updatedAt: record.updatedAt,
				...("title" in record && typeof record.title === "string" ? { title: record.title } : {}),
			};
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	put(record: AcpSessionRecord): void {
		if (!/^[a-zA-Z0-9_-]+$/.test(record.id)) throw new Error("Invalid ACP session identity.");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const temporary = join(this.directory, `.${randomUUID()}.tmp`);
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, join(this.directory, `${record.id}.json`));
	}

	list(): AcpSessionRecord[] {
		let names: string[];
		try {
			names = readdirSync(this.directory);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		return names
			.filter((name) => name.endsWith(".json"))
			.flatMap((name) => {
				const record = this.get(name.slice(0, -5));
				return record ? [record] : [];
			})
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}
}
