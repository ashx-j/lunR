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
 *
 * Fallback models (2026-08-02): settings.json `cronFallbackModels`
 * ("provider/modelId" entries) are tried IN ORDER when a fire fails — timeout
 * or any error. Each attempt gets a fresh headless session and
 * jobTimeoutMs/candidates of the budget; a successful fallback run prefixes
 * "[fell back to provider/modelId]" to the output. TUI fires are unaffected
 * (they use the live session's model).
 */

import type { Model } from "@earendil-works/pi-ai";
import { beginCronFire, endCronFire } from "../core/cron/fire-guard.ts";
import type { CronJob, CronJobOrigin } from "../core/cron/jobs.ts";
import { setCronDeliverValidator } from "../core/cron/jobs.ts";
import { startScheduler } from "../core/cron/scheduler.ts";
import type { BridgeSession } from "./agent-bridge.ts";
import { type GatewayConfig, platformConfigFor } from "./config.ts";
import { splitMessage } from "./text.ts";
import type { PlatformAdapter } from "./types.ts";

const DELIVERY_BRIDGE_SYMBOL = Symbol.for("@lunr/cron-delivery");

type DeliveryBridge = (job: CronJob, content: string) => Promise<string | null>;

/** Test seam / default: one fresh headless session per cron fire. */
export interface CronModelRef {
	provider: string;
	modelId: string;
}

export type CronSessionFactory = (job: CronJob, modelOverride?: CronModelRef) => Promise<BridgeSession>;

export interface GatewayCronOptions {
	adapters: Map<string, PlatformAdapter>;
	cfg: GatewayConfig;
	/** Tick interval; default 60s. */
	intervalMs?: number;
	/** Session factory for cron fires; defaults to a real headless agent session. */
	sessionFactory?: CronSessionFactory;
	/** Test seam: fallback models. When omitted, read fresh from settings.json `cronFallbackModels` on every fire. */
	fallbackModels?: CronModelRef[];
}

const KNOWN_PLATFORMS = ["telegram", "discord"] as const;

/** Default factory: fresh in-memory headless session, mirroring agent-bridge's wiring. */
async function defaultCronSessionFactory(job: CronJob, modelOverride?: CronModelRef): Promise<BridgeSession> {
	const [
		{ loadAllBuiltinExtensions },
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
		resourceLoaderOptions: { extensionFactories: await loadAllBuiltinExtensions() },
	});
	// Fallback-model attempts pin the session model explicitly; an unresolvable
	// or unauthenticated override fails the attempt so the next fallback runs.
	let model: Model<any> | undefined;
	if (modelOverride) {
		const resolved = services.modelRuntime.getModel(modelOverride.provider, modelOverride.modelId);
		if (!resolved) throw new Error(`model not found: ${modelOverride.provider}/${modelOverride.modelId}`);
		if (!services.modelRuntime.hasConfiguredAuth(resolved.provider)) {
			throw new Error(`no configured auth for provider: ${modelOverride.provider}`);
		}
		model = resolved;
	}
	const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
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

function createDeliverValidator(
	cfg: GatewayConfig,
): (deliver: string, origin?: CronJobOrigin | null) => string | undefined {
	return (deliver, origin) => {
		const targets = deliver
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		for (const target of targets) {
			if (target === "local") continue;
			if (target === "origin") continue; // delivery time resolves/fails with a sensible error
			const explicit = EXPLICIT_TARGET_RE.exec(target);
			const platform = explicit ? explicit[1].toLowerCase() : target.toLowerCase();
			const platformCfg = platformConfigFor(cfg, platform);
			if (!platformCfg) return `unknown platform "${explicit ? explicit[1] : target}"`;
			if (explicit) {
				const chatId = explicit[2];
				const allowed = new Set(
					[
						platformCfg.homeChannel,
						...(platformCfg.allowedChats ?? []),
						...(origin?.platform === platform ? [origin.chatId] : []),
					].filter((x): x is string => !!x),
				);
				if (!allowed.has(chatId)) {
					return `deliver target "${target}" is not an allowed chat for ${platform}`;
				}
			} else if (!platformCfg.homeChannel) {
				return `no homeChannel configured for ${platform}`;
			}
		}
		return undefined;
	};
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

/** Race one prompt attempt against its share of the job budget. */
function withAttemptTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`attempt timed out after ${ms}ms`)), ms);
			// If the attempt settles first this promise is discarded; the timer must not keep the process alive.
			timer.unref?.();
		}),
	]);
}

/**
 * Read settings.json `cronFallbackModels` ("provider/modelId" entries).
 * Fresh read per fire so edits apply without a daemon restart; invalid
 * entries are skipped with a log line. Never throws.
 */
async function readCronFallbackModels(): Promise<CronModelRef[]> {
	try {
		const [{ getAgentDir }, { SettingsManager }] = await Promise.all([
			import("../config.ts"),
			import("../core/settings-manager.ts"),
		]);
		const settingsManager = SettingsManager.create(process.cwd(), getAgentDir(), { projectTrusted: false });
		const out: CronModelRef[] = [];
		for (const entry of settingsManager.getCronFallbackModels()) {
			const idx = entry.indexOf("/");
			if (idx <= 0 || idx === entry.length - 1) {
				console.error(
					`[gateway cron] ignoring invalid cronFallbackModels entry "${entry}" (want "provider/modelId")`,
				);
				continue;
			}
			out.push({ provider: entry.slice(0, idx), modelId: entry.slice(idx + 1) });
		}
		return out;
	} catch (err) {
		console.error(
			`[gateway cron] failed to read cronFallbackModels: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}

/**
 * Start the cron scheduler inside the gateway daemon. Starts even with zero
 * stored jobs — jobs can be created later from chats. stop() halts the loop.
 */
export function startGatewayCron(options: GatewayCronOptions): { stop(): void; intervalMs: number } {
	const { adapters, cfg } = options;
	const sessionFactory = options.sessionFactory ?? defaultCronSessionFactory;
	const platformDeliverer = createPlatformDeliverer(adapters, cfg);

	// Explicit so runJob can split it into per-attempt budgets that sum to (at
	// most) the scheduler's outer race (core/cron/scheduler.ts runSchedulerTick).
	const jobTimeoutMs = 5 * 60 * 1000;

	// Reject deliver targets that are not local, origin, a configured home channel,
	// or an explicit chat in the platform allowlist / the job's origin.
	setCronDeliverValidator(createDeliverValidator(cfg));

	// Replace the local-notify bridge lunr-cron registered with the platform deliverer.
	(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = platformDeliverer;

	const runJob = async (prompt: string, job: CronJob): Promise<string> => {
		const fallbacks = options.fallbackModels ?? (await readCronFallbackModels());
		const candidates: Array<CronModelRef | undefined> = [undefined, ...fallbacks];
		const attemptTimeoutMs = Math.floor(jobTimeoutMs / candidates.length);
		const errors: string[] = [];
		beginCronFire();
		try {
			for (const candidate of candidates) {
				const label = candidate ? `${candidate.provider}/${candidate.modelId}` : "default model";
				let session: BridgeSession | undefined;
				try {
					session = await sessionFactory(job, candidate);
					// Loading the builtin extensions re-registered lunr-cron's local-notify
					// bridge; restore the platform deliverer before any delivery re-reads it.
					(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = platformDeliverer;
					await withAttemptTimeout(session.prompt(prompt, { source: "extension" }), attemptTimeoutMs);
					const text = extractFinalText(session);
					// The marker lands in the output file (the audit trail); [SILENT] as
					// the last line still suppresses delivery (scheduler isSilent check).
					return candidate ? `[fell back to ${label}]\n${text}` : text;
				} catch (err) {
					errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
				} finally {
					session?.dispose?.();
				}
			}
			throw new Error(errors.join(" | ") || "no model candidates");
		} finally {
			endCronFire();
		}
	};

	const deliverResult = async (job: CronJob, content: string): Promise<void> => {
		// Re-read the bridge on every delivery (same pattern as lunr-cron).
		const bridge = (globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] as DeliveryBridge | undefined;
		if (!bridge) throw new Error("no cron delivery bridge registered");
		const err = await bridge(job, content);
		if (err) throw new Error(err);
	};

	const scheduler = startScheduler({ runJob, deliverResult, intervalMs: options.intervalMs, jobTimeoutMs });
	return { stop: () => scheduler.stop(), intervalMs: options.intervalMs ?? 60_000 };
}
