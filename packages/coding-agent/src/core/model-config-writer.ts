/**
 * Mutable writer for models.json. ModelConfig (model-config.ts) is an immutable,
 * credential-blind snapshot; this module is the only write path and never silently
 * drops an existing file it cannot parse.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import type { ModelsJsonProvider } from "./model-config.ts";

type ModelsJsonDocument = { providers: Record<string, ModelsJsonProvider> };

/**
 * Derive a provider id from a display name: lowercase, non-alphanumeric runs
 * collapse to "-", trimmed. Falls back to "custom" when nothing alphanumeric
 * remains, and dedups against existing ids with "-2", "-3", …
 */
export function slugifyProviderId(name: string, existingIds: readonly string[]): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const stem = base || "custom";
	if (!existingIds.includes(stem)) return stem;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${stem}-${suffix}`;
		if (!existingIds.includes(candidate)) return candidate;
	}
}

/** Custom endpoints must be absolute http(s) URLs. */
export function isValidProviderBaseUrl(value: string): boolean {
	return /^https?:\/\/\S+$/u.test(value.trim());
}

/** Parse a comma-separated model id list: trims entries, drops empties, dedups. */
export function parseModelIds(input: string): string[] {
	const seen = new Set<string>();
	for (const entry of input.split(",")) {
		const id = entry.trim();
		if (id) seen.add(id);
	}
	return [...seen];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Insert or replace one provider in models.json, preserving every other provider
 * (and object key order). A missing file starts from `{ providers: {} }`; a file
 * that exists but does not parse or has the wrong shape throws — the user's
 * existing configuration is never overwritten on a read failure.
 */
export async function upsertCustomProvider(
	modelsJsonPath: string,
	providerId: string,
	providerConfig: ModelsJsonProvider,
): Promise<void> {
	const path = normalizePath(modelsJsonPath);
	let document: ModelsJsonDocument;

	let content: string | undefined;
	try {
		content = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(
				`Cannot update models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}
	}

	if (content === undefined) {
		document = { providers: {} };
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(content));
		} catch (error) {
			throw new Error(
				`Cannot update models.json: the existing file is not valid JSON (${error instanceof Error ? error.message : error}). Fix or remove it and try again.\n\nFile: ${path}`,
			);
		}
		if (!isRecord(parsed) || !isRecord(parsed.providers)) {
			throw new Error(
				`Cannot update models.json: the existing file must be an object with a "providers" record. Fix or remove it and try again.\n\nFile: ${path}`,
			);
		}
		document = parsed as ModelsJsonDocument;
	}

	document.providers[providerId] = providerConfig;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
}
