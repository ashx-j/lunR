/**
 * lunR: gateway config (<agentDir>/gateway.json).
 *
 * Follows the pi-ollama-cloud load/save pattern: JSON file under the agent
 * dir (getAgentDir(), honoring PI_CODING_AGENT_DIR), defaults when missing,
 * unknown keys dropped, malformed file tolerated. Writes are atomic
 * (tmp + rename) and the file is created chmod 0600 best-effort — it may
 * hold bot tokens.
 *
 * Token resolution order: LUNR_<PLATFORM>_BOT_TOKEN env →
 * <PLATFORM>_BOT_TOKEN env → file token.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export interface PlatformConfig {
	enabled: boolean;
	token?: string;
	allowedUsers: string[];
	allowedChats: string[];
	requireMention: boolean;
	freeResponseChats: string[];
	homeChannel?: string;
}

export interface DiscordConfig extends PlatformConfig {
	ignoredChannels: string[];
	autoThread: boolean;
}

export interface StreamingConfig {
	enabled: boolean;
	editIntervalMs: number;
	bufferThreshold: number;
}

export interface GatewayConfig {
	telegram: PlatformConfig;
	discord: DiscordConfig;
	/** Group/channel chats get one session per user when true. */
	groupSessionsPerUser: boolean;
	/** What to do with DMs from unauthorized users. */
	unauthorizedDmBehavior: "pair" | "ignore";
	streaming: StreamingConfig;
}

export function gatewayConfigPath(): string {
	return join(getAgentDir(), "gateway.json");
}

function defaultPlatformConfig(requireMention: boolean): PlatformConfig {
	return {
		enabled: false,
		allowedUsers: [],
		allowedChats: [],
		requireMention,
		freeResponseChats: [],
	};
}

export function defaultGatewayConfig(): GatewayConfig {
	return {
		telegram: defaultPlatformConfig(false),
		discord: { ...defaultPlatformConfig(true), ignoredChannels: [], autoThread: true },
		groupSessionsPerUser: true,
		unauthorizedDmBehavior: "pair",
		streaming: { enabled: true, editIntervalMs: 800, bufferThreshold: 24 },
	};
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizePlatform(raw: unknown, base: PlatformConfig): PlatformConfig {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return base;
	const r = raw as Record<string, unknown>;
	return {
		enabled: asBoolean(r.enabled) ?? base.enabled,
		token: typeof r.token === "string" ? r.token : base.token,
		allowedUsers: asStringArray(r.allowedUsers) ?? base.allowedUsers,
		allowedChats: asStringArray(r.allowedChats) ?? base.allowedChats,
		requireMention: asBoolean(r.requireMention) ?? base.requireMention,
		freeResponseChats: asStringArray(r.freeResponseChats) ?? base.freeResponseChats,
		homeChannel: typeof r.homeChannel === "string" ? r.homeChannel : base.homeChannel,
	};
}

function sanitizeDiscord(raw: unknown, base: DiscordConfig): DiscordConfig {
	const platform = sanitizePlatform(raw, base);
	const r = raw != null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		...platform,
		ignoredChannels: asStringArray(r.ignoredChannels) ?? base.ignoredChannels,
		autoThread: asBoolean(r.autoThread) ?? base.autoThread,
	};
}

function sanitizeConfig(raw: unknown): GatewayConfig {
	const base = defaultGatewayConfig();
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return base;
	const r = raw as Record<string, unknown>;
	const streamingRaw =
		r.streaming != null && typeof r.streaming === "object" && !Array.isArray(r.streaming)
			? (r.streaming as Record<string, unknown>)
			: {};
	return {
		telegram: sanitizePlatform(r.telegram, base.telegram),
		discord: sanitizeDiscord(r.discord, base.discord),
		groupSessionsPerUser: asBoolean(r.groupSessionsPerUser) ?? base.groupSessionsPerUser,
		unauthorizedDmBehavior: r.unauthorizedDmBehavior === "ignore" ? "ignore" : "pair",
		streaming: {
			enabled: asBoolean(streamingRaw.enabled) ?? base.streaming.enabled,
			editIntervalMs: asNumber(streamingRaw.editIntervalMs) ?? base.streaming.editIntervalMs,
			bufferThreshold: asNumber(streamingRaw.bufferThreshold) ?? base.streaming.bufferThreshold,
		},
	};
}

/** Load <agentDir>/gateway.json; defaults (both platforms disabled) when missing or malformed. */
export function loadGatewayConfig(): GatewayConfig {
	const path = gatewayConfigPath();
	if (!existsSync(path)) return defaultGatewayConfig();
	try {
		return sanitizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (err) {
		console.error(`[gateway] Failed to load config from ${path}: ${err}`);
		return defaultGatewayConfig();
	}
}

/** Write the whole config atomically (tmp + rename); chmod 0600 best-effort. */
export function saveGatewayConfig(config: GatewayConfig): void {
	const path = gatewayConfigPath();
	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o600);
	} catch {
		// best-effort (Windows ACLs don't map cleanly)
	}
}

/**
 * Resolve a platform's bot token: LUNR_<PLATFORM>_BOT_TOKEN env →
 * <PLATFORM>_BOT_TOKEN env → config file token.
 */
export function resolvePlatformToken(platform: string, platformCfg: PlatformConfig): string | undefined {
	const upper = platform.toUpperCase();
	return process.env[`LUNR_${upper}_BOT_TOKEN`] ?? process.env[`${upper}_BOT_TOKEN`] ?? platformCfg.token;
}

/** Per-platform config lookup; undefined for platforms Phase 2a doesn't model. */
export function platformConfigFor(cfg: GatewayConfig, platform: string): PlatformConfig | undefined {
	if (platform === "telegram") return cfg.telegram;
	if (platform === "discord") return cfg.discord;
	return undefined;
}
