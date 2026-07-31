/**
 * lunR: gateway daemon entry (Phase 2a skeleton; Phase 2b registered the
 * Telegram adapter, Phase 3 the Discord adapter — both via ADAPTER_FACTORIES).
 *
 * `lunr gateway` runs the daemon: load gateway.json, instantiate every
 * enabled platform that has a registered adapter factory AND a resolvable
 * token, connect, route messages, and stay alive until SIGINT/SIGTERM.
 * With no runnable adapters it prints per-platform setup instructions and
 * exits 1.
 *
 * Sub-commands:
 *   lunr gateway pair approve <platform> <code>   approve a pairing code
 *   lunr gateway pair list                        show pending + paired
 *   lunr gateway status                           config/token/session summary
 */

import { DiscordAdapter } from "./adapters/discord.ts";
import { TelegramAdapter } from "./adapters/telegram.ts";
import { AgentBridge } from "./agent-bridge.ts";
import { handleApprovalCallback } from "./approval.ts";
import { addAllowedUser } from "./authz.ts";
import { handleCallback, startButtonSweeper, stopButtonSweeper } from "./buttons.ts";
import {
	type DiscordConfig,
	loadGatewayConfig,
	type PlatformConfig,
	platformConfigFor,
	resolvePlatformToken,
} from "./config.ts";
import { startGatewayCron } from "./cron.ts";
import { createPairingStore } from "./pairing.ts";
import { createRouter } from "./router.ts";
import { listSessions } from "./store.ts";
import type { PlatformAdapter } from "./types.ts";

/**
 * Adapter registry — the seam adapters plug into:
 *
 *   ADAPTER_FACTORIES.<platform> = (cfg) => new SomeAdapter(cfg);
 *
 * A factory receives the sanitized platform config with the token already
 * resolved into cfg.token (env beats file — see resolvePlatformToken and
 * runDaemon below). The registry type is the PlatformConfig base; adapters
 * with extra fields (Discord) narrow with a cast — the daemon always passes
 * the full sanitized per-platform object.
 */
export const ADAPTER_FACTORIES: Record<string, (cfg: PlatformConfig) => PlatformAdapter> = {
	telegram: (cfg) => new TelegramAdapter(cfg),
	discord: (cfg) => new DiscordAdapter(cfg as DiscordConfig),
};

const KNOWN_PLATFORMS = ["telegram", "discord"] as const;

const SETUP_INSTRUCTIONS: Record<string, string[]> = {
	telegram: [
		"Telegram: talk to @BotFather → /newbot → copy the token into",
		"  <agentDir>/gateway.json (telegram.token) or export LUNR_TELEGRAM_BOT_TOKEN,",
		"  then set telegram.enabled = true.",
	],
	discord: [
		"Discord: discord.com/developers → New Application → Bot → copy the token into",
		"  <agentDir>/gateway.json (discord.token) or export LUNR_DISCORD_BOT_TOKEN,",
		"  enable the MESSAGE CONTENT intent, then set discord.enabled = true.",
	],
};

function printSetupInstructions(enabledButUnrunnable: string[]): void {
	console.log("lunR gateway: no runnable platforms configured.");
	for (const platform of enabledButUnrunnable) {
		console.log(`  (platform "${platform}" is enabled but has no registered adapter or resolvable token)`);
	}
	for (const platform of KNOWN_PLATFORMS) {
		for (const line of SETUP_INSTRUCTIONS[platform]) {
			console.log(line);
		}
	}
}

async function runPairApprove(platform: string, code: string | undefined): Promise<number> {
	if (!code) {
		console.error("Usage: lunr gateway pair approve <platform> <code>");
		return 1;
	}
	const pairing = createPairingStore();
	const userId = pairing.approve(platform, code);
	if (userId === null) {
		console.error(`Pairing failed: no valid pending code "${code}" for ${platform} (wrong, expired, or locked out).`);
		return 1;
	}
	try {
		addAllowedUser(platform, userId);
	} catch (err) {
		console.error(`Paired ${platform} user ${userId}, but could not persist allowedUsers: ${err}`);
		return 1;
	}
	console.log(`Approved ${platform} user ${userId} (added to ${platform}.allowedUsers in gateway.json).`);
	return 0;
}

function runPairList(): number {
	const pairing = createPairingStore();
	const pending = pairing.listPending();
	const approved = pairing.listApproved();
	console.log("Pending pairing codes:");
	if (pending.length === 0) {
		console.log("  (none)");
	} else {
		for (const p of pending) {
			console.log(`  ${p.platform} ${p.code}  user=${p.userId}  expires ${new Date(p.expiresAt).toISOString()}`);
		}
	}
	console.log("Paired users:");
	if (approved.length === 0) {
		console.log("  (none)");
	} else {
		for (const u of approved) {
			console.log(`  ${u.platform} ${u.userId}  approved ${new Date(u.approvedAt).toISOString()}`);
		}
	}
	return 0;
}

function runStatus(): number {
	const cfg = loadGatewayConfig();
	console.log("lunR gateway status:");
	for (const platform of KNOWN_PLATFORMS) {
		const platformCfg = platformConfigFor(cfg, platform);
		if (!platformCfg) continue;
		const token = resolvePlatformToken(platform, platformCfg);
		const adapter = ADAPTER_FACTORIES[platform] === undefined ? "no adapter" : "adapter registered";
		console.log(
			`  ${platform}: ${platformCfg.enabled ? "enabled" : "disabled"} · token ${token ? "resolved" : "missing"} · ${adapter}`,
		);
	}
	const sessions = listSessions();
	console.log(`  sessions: ${Object.keys(sessions).length} stored`);
	return 0;
}

async function runDaemon(): Promise<number> {
	const cfg = loadGatewayConfig();
	const adapters = new Map<string, PlatformAdapter>();
	const skipped: string[] = [];

	for (const platform of KNOWN_PLATFORMS) {
		const platformCfg = platformConfigFor(cfg, platform);
		if (!platformCfg?.enabled) continue;
		const factory: ((cfg: PlatformConfig) => PlatformAdapter) | undefined = ADAPTER_FACTORIES[platform];
		if (factory === undefined) {
			skipped.push(platform);
			continue;
		}
		const token = resolvePlatformToken(platform, platformCfg);
		if (!token) {
			skipped.push(platform);
			continue;
		}
		adapters.set(platform, factory({ ...platformCfg, token }));
	}

	if (adapters.size === 0) {
		printSetupInstructions(skipped);
		return 1;
	}

	const pairing = createPairingStore();
	const bridge = new AgentBridge();
	const router = createRouter({ adapters, cfg, pairing, bridge, reloadConfig: true });

	const connected: PlatformAdapter[] = [];
	startButtonSweeper();
	for (const [platform, adapter] of adapters) {
		try {
			const ok = await adapter.connect();
			if (!ok) {
				console.error(`[gateway] ${platform}: connect() reported failure; skipping`);
				continue;
			}
			adapter.onMessage((event) => {
				void router.handleEvent(event);
			});
			adapter.onCallback(async (event) => {
				const consumed = await handleApprovalCallback(event, adapter);
				if (!consumed) {
					void handleCallback(event, { adapters, cfg, pairing, bridge, adapter });
				}
			});
			connected.push(adapter);
			console.log(`lunR gateway: ${platform} connected`);
		} catch (err) {
			console.error(`[gateway] ${platform}: connect failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (connected.length === 0) {
		console.error("lunR gateway: every configured platform failed to connect.");
		stopButtonSweeper();
		return 1;
	}

	// Phase 4: cron jobs fire inside the daemon and deliver back to chats.
	// Starts even with zero stored jobs — jobs can be created later from chats.
	const cron = startGatewayCron({ adapters, cfg });
	console.log(`lunR gateway: cron scheduler started (${cron.intervalMs / 1000}s interval)`);

	const shutdown = () => {
		cron.stop();
		stopButtonSweeper();
		void Promise.all(connected.map((adapter) => adapter.disconnect().catch(() => {}))).finally(() => {
			process.exit(0);
		});
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	await new Promise<void>(() => {
		// Keep the process alive until SIGINT/SIGTERM.
	});
	return 0;
}

export async function runGateway(args: string[]): Promise<number> {
	const [sub, ...rest] = args;
	if (sub === "pair") {
		const [action, platform, code] = rest;
		if (action === "approve" && platform) return runPairApprove(platform, code);
		if (action === "list") return runPairList();
		console.error("Usage: lunr gateway pair approve <platform> <code> | lunr gateway pair list");
		return 1;
	}
	if (sub === "status") return runStatus();
	if (sub === undefined) return runDaemon();
	console.error(`Unknown gateway sub-command "${sub}". Expected: pair approve | pair list | status`);
	return 1;
}
