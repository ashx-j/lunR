/**
 * lunR: gateway authorization — fail-closed, layered:
 *   1. LUNR_GATEWAY_ALLOW_ALL_USERS=true env (escape hatch)
 *   2. chatId in the platform's allowedChats (chat-scoped grant)
 *   3. adapter-asserted roleAuthorized
 *   4. paired via the pairing store
 *   5. userId in the platform's allowedUsers or global
 *      LUNR_GATEWAY_ALLOWED_USERS (comma-separated env)
 *   6. denied
 */

import { type GatewayConfig, loadGatewayConfig, platformConfigFor, saveGatewayConfig } from "./config.ts";
import type { PairingStore } from "./pairing.ts";
import type { SessionSource } from "./types.ts";

function envFlagEnabled(name: string): boolean {
	const raw = process.env[name];
	if (raw === undefined) return false;
	return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function globalAllowedUsers(): string[] {
	const raw = process.env.LUNR_GATEWAY_ALLOWED_USERS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
}

export function isAuthorized(source: SessionSource, cfg: GatewayConfig, pairing: PairingStore): boolean {
	if (envFlagEnabled("LUNR_GATEWAY_ALLOW_ALL_USERS")) return true;
	const platformCfg = platformConfigFor(cfg, source.platform);
	if (platformCfg?.allowedChats.includes(source.chatId)) return true;
	if (source.roleAuthorized === true) return true;
	if (source.userId && pairing.isPaired(source.platform, source.userId)) return true;
	if (source.userId) {
		if (platformCfg?.allowedUsers.includes(source.userId)) return true;
		if (globalAllowedUsers().includes(source.userId)) return true;
	}
	return false;
}

/**
 * Append a user to a platform's allowedUsers in the saved gateway.json
 * (used after a pairing approval so the grant survives pairing-store resets).
 * No-op when already present.
 */
export function addAllowedUser(platform: string, userId: string): void {
	const cfg = loadGatewayConfig();
	const platformCfg = platformConfigFor(cfg, platform);
	if (!platformCfg) {
		throw new Error(`Unknown platform "${platform}"`);
	}
	if (!platformCfg.allowedUsers.includes(userId)) {
		platformCfg.allowedUsers.push(userId);
		saveGatewayConfig(cfg);
	}
}
