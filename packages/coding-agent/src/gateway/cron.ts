/**
 * lunR: gateway cron runner + delivery (Phase 4 of the cron/gateway roadmap).
 *
 * startGatewayCron() runs the core/cron scheduler inside the `lunr gateway`
 * daemon:
 *
 *  - runJob: each fire gets a FRESH headless agent session (createAgentSession
 *    with SessionManager.inMemory — cron runs never write session files and
 *    never touch the per-chat gateway sessions; the files under
 *    <agentDir>/cron/output/ are the audit trail). The shared fire-guard
 *    (core/cron/fire-guard) brackets the turn so the `cron` tool refuses to
 *    run inside it (jobs cannot schedule jobs).
 *  - deliverResult: replaces the `@lunr/cron-delivery` bridge on globalThis
 *    with a platform deliverer. Targets come from job.deliver
 *    (comma-separated): "local" (no-op — the output file is already written),
 *    "origin" (the chat that created the job, homeChannel fallback), a bare
 *    platform name (that platform's homeChannel), or
 *    "<platform>:<chatId>[:<threadId>]" (explicit). Content is wrapped as
 *    "☾ Cron: <name>" and split to the adapter's maxMessageLength.
 *
 * The bridge is re-installed after every cron session creation because loading
 * the builtin extensions (lunr-cron) re-registers its local-notify bridge per
 * session; delivery re-reads the bridge on every call, matching lunr-cron.
 */

import { beginCronFire, endCronFire } from "../core/cron/fire-guard.ts";
import type { CronJob } from "../core/cron/jobs.ts";
import { startScheduler } from "../core/cron/scheduler.ts";
import type { BridgeSession } from "./agent-bridge.ts";
import { type GatewayConfig, platformConfigFor } from "./config.ts";
import { splitMessage } from "./text.ts";
import type { PlatformAdapter } from "./types.ts";

const DELIVERY_BRIDGE_SYMBOL = Symbol.for("@lunr/cron-delivery");

type DeliveryBridge = (job: CronJob, content: string) => Promise<string | null>;

/** Test seam / default: one fresh headless session per cron fire. */
export type CronSessionFactory = (job: CronJob) => Promise<BridgeSession>;

export interface GatewayCronOptions {
	adapters: Map<string, PlatformAdapter>;
	cfg: GatewayConfig;
	/** Tick interval; default 60s. */
	intervalMs?: number;
	/** Session factory for cron fires; defaults to a real headless agent session. */
	sessionFactory?: CronSessionFactory;
}

const KNOWN_PLATFORMS = ["telegram", "discord"] as const;

/** Default factory: fresh in-memory headless session, mirroring agent-bridge's wiring. */
async function defaultCronSessionFactory(job: CronJob): Promise<BridgeSession> {
	const [
		{ builtinExtensions },
		{ getAgentDir },
		{ registerCustomizeBridge },
		{ registerMemoryCapBridge },
		{ registerModelTierBridge },
		{ createAgentSessionFromServices, createAgentSessionServices },
		{ SessionManager },
		{ SettingsManager },
	] = await Promise.all([
		import("../builtin-extensions/index.ts"),
		import("../config.ts"),
		import("../core/customize.ts"),
		import("../core/memory-cap.ts"),
		import("../core/model-tiers.ts"),
		import("../core/agent-session-services.ts"),
		import("../core/session-manager.ts"),
		import("../core/settings-manager.ts"),
	]);
	const cwd = job.workdir ?? process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	registerModelTierBridge(settingsManager);
	registerMemoryCapBridge(settingsManager);
	registerCustomizeBridge(settingsManager);

	// In-memory on purpose: cron runs must not persist session files or pollute
	// the per-chat gateway sessions — <agentDir>/cron/output/ is the audit trail.
	const sessionManager = SessionManager.inMemory(cwd);

	// Services-first (mirrors main.ts): extension-registered providers (e.g.
	// ollama-cloud) must land in the shared ModelRuntime BEFORE session
	// creation — otherwise findInitialModel can't resolve the user's default
	// model and silently falls back to an arbitrary catalog provider.
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: { extensionFactories: [...builtinExtensions] },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager });
	await session.bindExtensions({
		mode: "print",
		onError: (err) => console.error(`[gateway cron] extension error (${err.extensionPath}): ${err.error}`),
	});
	return session;
}

/** Final assistant text, print-mode style; throws on error/aborted stop. */
function extractFinalText(session: BridgeSession): string {
	const messages = session.state.messages;
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return "";
	const assistant = last as {
		stopReason?: string;
		errorMessage?: string;
		content?: Array<{ type: string; text?: string }>;
	};
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		throw new Error(assistant.errorMessage || `Request ${assistant.stopReason}`);
	}
	let text = "";
	for (const content of assistant.content ?? []) {
		if (content.type === "text") text += content.text ?? "";
	}
	return text;
}

interface ResolvedTarget {
	platform: string;
	chatId: string;
	threadId?: string;
}

const EXPLICIT_TARGET_RE = /^([a-z0-9_-]+):([^:]+)(?::([^:]+))?$/i;

/** Resolve one deliver target to a concrete destination. Returns an error string on failure. */
function resolveTarget(target: string, job: CronJob, cfg: GatewayConfig): ResolvedTarget | string {
	if (target === "origin") {
		const origin = job.origin;
		if (origin?.platform && origin.chatId) {
			return { platform: origin.platform, chatId: origin.chatId, threadId: origin.threadId };
		}
		// Missing/incomplete origin → fall back to a homeChannel: the origin's
		// platform when known, otherwise the first platform that has one.
		const platforms = origin?.platform ? [origin.platform] : KNOWN_PLATFORMS;
		for (const platform of platforms) {
			const home = platformConfigFor(cfg, platform)?.homeChannel;
			if (home) return { platform, chatId: home };
		}
		return `deliver target "origin": job has no origin and no homeChannel is configured`;
	}

	const explicit = EXPLICIT_TARGET_RE.exec(target);
	const platform = explicit ? explicit[1].toLowerCase() : target.toLowerCase();
	if (platformConfigFor(cfg, platform) === undefined) {
		return `unknown platform "${explicit ? explicit[1] : target}"`;
	}
	if (explicit) {
		return { platform, chatId: explicit[2], threadId: explicit[3] };
	}
	// Bare platform name → its homeChannel.
	const home = platformConfigFor(cfg, platform)?.homeChannel;
	if (!home) return `no homeChannel configured for ${platform}`;
	return { platform, chatId: home };
}

/** Wrap the run output with a compact cron header. */
export function wrapCronContent(job: CronJob, content: string): string {
	return `☾ Cron: ${job.name}\n———\n${content}`;
}

/**
 * The platform deliverer installed at the `@lunr/cron-delivery` bridge.
 * Every target is attempted; the first error is returned (null on success).
 */
export function createPlatformDeliverer(adapters: Map<string, PlatformAdapter>, cfg: GatewayConfig): DeliveryBridge {
	return async (job, content) => {
		const targets = job.deliver
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		let firstError: string | null = null;
		for (const target of targets) {
			if (target === "local") continue; // output file already written by the scheduler
			const resolved = resolveTarget(target, job, cfg);
			if (typeof resolved === "string") {
				firstError ??= resolved;
				continue;
			}
			const adapter = adapters.get(resolved.platform);
			if (!adapter) {
				firstError ??= `no adapter connected for ${resolved.platform}`;
				continue;
			}
			const wrapped = wrapCronContent(job, content);
			for (const chunk of splitMessage(wrapped, adapter.maxMessageLength)) {
				try {
					const result = await adapter.send(resolved.chatId, chunk, {
						threadId: resolved.threadId,
					});
					if (!result.success) {
						firstError ??= `${resolved.platform} send failed: ${result.error ?? "unknown error"}`;
						break;
					}
				} catch (err) {
					firstError ??= `${resolved.platform} send failed: ${err instanceof Error ? err.message : String(err)}`;
					break;
				}
			}
		}
		return firstError;
	};
}

/**
 * Start the cron scheduler inside the gateway daemon. Starts even with zero
 * stored jobs — jobs can be created later from chats. stop() halts the loop.
 */
export function startGatewayCron(options: GatewayCronOptions): { stop(): void; intervalMs: number } {
	const { adapters, cfg } = options;
	const sessionFactory = options.sessionFactory ?? defaultCronSessionFactory;
	const platformDeliverer = createPlatformDeliverer(adapters, cfg);

	// Replace the local-notify bridge lunr-cron registered with the platform deliverer.
	(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = platformDeliverer;

	const runJob = async (prompt: string, job: CronJob): Promise<string> => {
		beginCronFire();
		let session: BridgeSession | undefined;
		try {
			session = await sessionFactory(job);
			// Loading the builtin extensions re-registered lunr-cron's local-notify
			// bridge; restore the platform deliverer before any delivery re-reads it.
			(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = platformDeliverer;
			await session.prompt(prompt, { source: "extension" });
			return extractFinalText(session);
		} finally {
			endCronFire();
			session?.dispose?.();
		}
	};

	const deliverResult = async (job: CronJob, content: string): Promise<void> => {
		// Re-read the bridge on every delivery (same pattern as lunr-cron).
		const bridge = (globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] as DeliveryBridge | undefined;
		if (!bridge) throw new Error("no cron delivery bridge registered");
		const err = await bridge(job, content);
		if (err) throw new Error(err);
	};

	const scheduler = startScheduler({ runJob, deliverResult, intervalMs: options.intervalMs });
	return { stop: () => scheduler.stop(), intervalMs: options.intervalMs ?? 60_000 };
}
