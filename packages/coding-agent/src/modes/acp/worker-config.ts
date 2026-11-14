import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerEntry } from "../../builtin-extensions/pi-mcp-adapter/types.ts";

export const ACP_WORKER_CONFIG_ENV = "LUNR_ACP_WORKER_CONFIG";

export interface AcpNameValue {
	name: string;
	value: string;
}

export type AcpMcpServer =
	| { name: string; command: string; args: string[]; env: AcpNameValue[]; type?: "stdio" }
	| { name: string; type: "http" | "sse"; url: string; headers: AcpNameValue[] };

export interface AcpWorkerConfig {
	mcpServers: AcpMcpServer[];
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nameValues(value: unknown): AcpNameValue[] {
	if (!Array.isArray(value)) throw new Error("ACP MCP environment or headers must be a list.");
	return value.map((entry: unknown) => {
		if (!record(entry) || typeof entry.name !== "string" || !entry.name || typeof entry.value !== "string") {
			throw new Error("ACP MCP environment or header entry is invalid.");
		}
		return { name: entry.name, value: entry.value };
	});
}

export function parseAcpWorkerConfig(value: unknown): AcpWorkerConfig {
	if (!record(value) || !Array.isArray(value.mcpServers)) throw new Error("Invalid ACP worker configuration.");
	const names = new Set<string>();
	const mcpServers = value.mcpServers.map((entry: unknown): AcpMcpServer => {
		if (!record(entry) || typeof entry.name !== "string" || !entry.name.trim() || names.has(entry.name)) {
			throw new Error("ACP MCP server names must be nonempty and unique.");
		}
		names.add(entry.name);
		if (entry.type === "http" || entry.type === "sse") {
			if (typeof entry.url !== "string") throw new Error("Invalid ACP MCP server URL.");
			const url = new URL(entry.url);
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid ACP MCP server protocol.");
			return { name: entry.name, type: entry.type, url: entry.url, headers: nameValues(entry.headers ?? []) };
		}
		if (
			(entry.type !== undefined && entry.type !== "stdio") ||
			typeof entry.command !== "string" ||
			!entry.command.trim() ||
			!Array.isArray(entry.args) ||
			!entry.args.every((arg: unknown) => typeof arg === "string")
		)
			throw new Error("Invalid ACP stdio MCP server.");
		return { name: entry.name, command: entry.command, args: entry.args, env: nameValues(entry.env ?? []) };
	});
	return { mcpServers };
}

let activeConfig: AcpWorkerConfig | undefined;
let activeConfigPath: string | undefined;

// retain the overlay after removing its process-only activation from child environments.
export function readAcpWorkerConfig(): AcpWorkerConfig | undefined {
	const path = process.env[ACP_WORKER_CONFIG_ENV];
	if (path) {
		activeConfig = parseAcpWorkerConfig(JSON.parse(readFileSync(path, "utf8")));
		activeConfigPath = path;
	}
	return activeConfig;
}

export function getAcpWorkerCachePath(): string | undefined {
	readAcpWorkerConfig();
	return activeConfigPath ? join(dirname(activeConfigPath), "mcp-cache.json") : undefined;
}

export function acpMcpServerOverlay(config: AcpWorkerConfig): Record<string, ServerEntry> {
	return Object.fromEntries(
		config.mcpServers.map((server) => [
			server.name,
			"command" in server
				? {
						command: server.command,
						args: server.args,
						env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
						lifecycle: "lazy" as const,
					}
				: {
						url: server.url,
						headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
						auth: false as const,
						oauth: false as const,
						lifecycle: "lazy" as const,
					},
		]),
	);
}
