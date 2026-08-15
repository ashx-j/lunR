import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { modelKey } from "./official-catalog.ts";

export const USER_MODELS_FILENAME = "user-models.json";

export interface UserModelEntry {
	id: string;
	name: string;
	api: Api;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
	contextWindow: number;
	maxTokens: number;
	compat?: Model<Api>["compat"];
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	source: "user";
}

export interface UserModelsFile {
	version: number;
	models: UserModelEntry[];
}

export function userModelsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, USER_MODELS_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function parseUserEntry(value: unknown): UserModelEntry | undefined {
	if (!isRecord(value)) return undefined;
	const id = typeof value.id === "string" ? value.id.trim() : "";
	const provider = typeof value.provider === "string" ? value.provider.trim() : "";
	if (!id || !provider) return undefined;
	const parsedInput: ("text" | "image")[] = Array.isArray(value.input)
		? value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
		: ["text"];
	const input: ("text" | "image")[] = parsedInput.length > 0 ? parsedInput : ["text"];
	const cost = isRecord(value.cost)
		? {
				input: asFiniteNumber(value.cost.input) ?? 0,
				output: asFiniteNumber(value.cost.output) ?? 0,
				cacheRead: asFiniteNumber(value.cost.cacheRead) ?? 0,
				cacheWrite: asFiniteNumber(value.cost.cacheWrite) ?? 0,
			}
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	return {
		id,
		name: typeof value.name === "string" && value.name.trim() ? value.name : id,
		api: typeof value.api === "string" && value.api.trim() ? value.api : "openai-completions",
		provider,
		baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
		reasoning: value.reasoning === true,
		input,
		cost,
		contextWindow: asFiniteNumber(value.contextWindow) ?? 128000,
		maxTokens: asFiniteNumber(value.maxTokens) ?? 8192,
		compat: isRecord(value.compat) ? (value.compat as Model<Api>["compat"]) : undefined,
		thinkingLevelMap: isRecord(value.thinkingLevelMap)
			? (value.thinkingLevelMap as Model<Api>["thinkingLevelMap"])
			: undefined,
		source: "user",
	};
}

export function emptyUserModels(): UserModelsFile {
	return { version: 1, models: [] };
}

/** Read user-models.json. Missing or unreadable files yield an empty document (never throws). */
export function readUserModels(path: string): UserModelsFile {
	try {
		if (!existsSync(path)) return emptyUserModels();
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(parsed) || !Array.isArray(parsed.models)) return emptyUserModels();
		const models: UserModelEntry[] = [];
		for (const entry of parsed.models) {
			const model = parseUserEntry(entry);
			if (model) models.push(model);
		}
		return { version: asFiniteNumber(parsed.version) ?? 1, models };
	} catch {
		return emptyUserModels();
	}
}

export function writeUserModels(file: UserModelsFile, path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ version: file.version ?? 1, models: file.models }, null, 2)}\n`, "utf-8");
}

export function evictUserModelsOnOfficial(
	user: UserModelsFile,
	officialKeys: Iterable<string>,
): { next: UserModelsFile; evicted: UserModelEntry[] } {
	const hits = new Set(officialKeys);
	const kept: UserModelEntry[] = [];
	const evicted: UserModelEntry[] = [];
	for (const model of user.models) {
		if (hits.has(modelKey(model.provider, model.id))) evicted.push(model);
		else kept.push(model);
	}
	return { next: { version: user.version, models: kept }, evicted };
}

export function evictUserModelsByProvider(
	user: UserModelsFile,
	providerId: string,
): { next: UserModelsFile; evicted: UserModelEntry[] } {
	const kept: UserModelEntry[] = [];
	const evicted: UserModelEntry[] = [];
	for (const model of user.models) {
		if (model.provider === providerId) evicted.push(model);
		else kept.push(model);
	}
	return { next: { version: user.version, models: kept }, evicted };
}

export function upsertUserModels(existing: UserModelsFile, rows: readonly UserModelEntry[]): UserModelsFile {
	const byKey = new Map(existing.models.map((model) => [modelKey(model.provider, model.id), model]));
	for (const row of rows) byKey.set(modelKey(row.provider, row.id), { ...row, source: "user" });
	return { version: existing.version ?? 1, models: [...byKey.values()] };
}

export function userEntryToModel(entry: UserModelEntry): Model<Api> {
	return {
		id: entry.id,
		name: entry.name,
		api: entry.api,
		provider: entry.provider,
		baseUrl: entry.baseUrl,
		reasoning: entry.reasoning,
		input: entry.input,
		cost: entry.cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		compat: entry.compat,
		thinkingLevelMap: entry.thinkingLevelMap,
	};
}

export function modelToUserEntry(model: Model<Api>): UserModelEntry {
	return {
		id: model.id,
		name: model.name,
		api: model.api,
		provider: model.provider,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: model.compat,
		thinkingLevelMap: model.thinkingLevelMap,
		source: "user",
	};
}

export class UserModelsStore {
	private readonly path: string | undefined;
	private file: UserModelsFile;

	constructor(path: string | undefined) {
		this.path = path;
		this.file = path ? readUserModels(path) : emptyUserModels();
	}

	list(): UserModelEntry[] {
		return this.file.models;
	}

	keys(): Set<string> {
		return new Set(this.file.models.map((model) => modelKey(model.provider, model.id)));
	}

	modelsFor(providerId: string): Model<Api>[] {
		return this.file.models.filter((model) => model.provider === providerId).map(userEntryToModel);
	}

	evictOfficial(officialKeys: Iterable<string>): UserModelEntry[] {
		const { next, evicted } = evictUserModelsOnOfficial(this.file, officialKeys);
		if (evicted.length > 0) {
			this.file = next;
			this.persist();
		}
		return evicted;
	}

	evictProvider(providerId: string): UserModelEntry[] {
		const { next, evicted } = evictUserModelsByProvider(this.file, providerId);
		if (evicted.length > 0) {
			this.file = next;
			this.persist();
		}
		return evicted;
	}

	upsert(rows: readonly UserModelEntry[]): void {
		if (rows.length === 0) return;
		this.file = upsertUserModels(this.file, rows);
		this.persist();
	}

	private persist(): void {
		if (!this.path) return;
		try {
			writeUserModels(this.file, this.path);
		} catch {
			// Persist is best-effort in test / in-memory runtimes.
		}
	}
}
