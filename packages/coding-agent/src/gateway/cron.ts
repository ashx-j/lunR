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
 *    "origin" (the identified, currently authorized requester chat), a bare
 *    platform name (that platform's homeChannel), or
 *    "<platform>:<chatId>[:<threadId>]" (explicit). Content is wrapped as
 *    "Cron: <name>" and split to the adapter's maxMessageLength.
 *
 * The compatibility delivery bridge exposes the platform deliverer. The scheduler
 * retains its own callback so another session cannot redirect its output.
 *
 * Fallback models: settings.json `cronFallbackModels`
 * ("provider/modelId" entries) are tried in order only when session setup fails before prompt dispatch.
 * An admitted failure may have external effects and is never replayed automatically; a successful fallback run prefixes
 * "[fell back to provider/modelId]" to the output. TUI fires are unaffected
 * (they use the live session's model).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beginCronFire, endCronFire } from "../core/cron/fire-guard.ts";
import type { CronJob, CronJobOrigin } from "../core/cron/jobs.ts";
import { setCronDeliverValidator } from "../core/cron/jobs.ts";
import { startScheduler } from "../core/cron/scheduler.ts";
import { createPermissionContext, deletePermissionContext } from "../core/permissions.ts";
import { type BridgeSession, shutdownBridgeSession } from "./agent-bridge.ts";
import { isAuthorized } from "./authz.ts";
import { type GatewayConfig, loadGatewayConfig, platformConfigFor } from "./config.ts";
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
	/** Config seam; production always reloads current grants. */
	getConfig?: () => GatewayConfig;
	jobTimeoutMs?: number;
}

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
		{ bindRuntimeBridges },
	] = await Promise.all([
		import("../builtin-extensions/index.ts"),
		import("../config.ts"),
		import("../core/customize.ts"),
		import("../core/memory-cap.ts"),
		import("../core/model-tiers.ts"),
		import("../core/agent-session-services.ts"),
		import("../core/session-manager.ts"),
		import("../core/settings-manager.ts"),
		import("../core/runtime-bridges.ts"),
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
	let model: Model<Api> | undefined;
	if (modelOverride) {
		const resolved = services.modelRuntime.getModel(modelOverride.provider, modelOverride.modelId);
		if (!resolved) throw new Error(`model not found: ${modelOverride.provider}/${modelOverride.modelId}`);
		if (!services.modelRuntime.hasConfiguredAuth(resolved.provider)) {
			throw new Error(`no configured auth for provider: ${modelOverride.provider}`);
		}
		model = resolved;
	}
	const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
	const permissionId = sessionManager.getSessionId();
	createPermissionContext(permissionId, settingsManager.getDefaultPermissionMode(), false);
	const dispose = session.dispose.bind(session);
	session.dispose = () => {
		deletePermissionContext(permissionId);
		dispose();
	};
	try {
		bindRuntimeBridges({ session, services });
		await session.bindExtensions({
			mode: "print",
			onError: (err) => console.error(`[gateway cron] extension error (${err.extensionPath}): ${err.error}`),
		});
		return session;
	} catch (error) {
		await shutdownBridgeSession(session, "quit");
		throw error;
	}
}

/** Final assistant text, print-mode style; throws on error/aborted stop. */
function extractFinalText(messages: AgentMessage[]): string {
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
		if (origin?.platform && origin.chatId && origin.userId) {
			return { platform: origin.platform, chatId: origin.chatId, threadId: origin.threadId };
		}
		return 'deliver target "origin": job has no origin requester identity; use /cron rebind from an approved gateway chat';
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

/** Rebuild the source from durable identity, never from persisted adapter role grants. */
function isAuthorizedOrigin(cfg: GatewayConfig, origin?: CronJobOrigin | null): boolean {
	if (!origin?.userId) return false;
	return isAuthorized(
		{
			platform: origin.platform,
			chatId: origin.chatId,
			userId: origin.userId,
			chatType: origin.chatType === "group" ? "group" : origin.chatType === "channel" ? "channel" : "dm",
			threadId: origin.threadId,
		},
		cfg,
	);
}

/** True when a resolved chat may receive cron output for this job. */
export function isAllowedDeliverChat(
	cfg: GatewayConfig,
	platform: string,
	chatId: string,
	origin?: CronJobOrigin | null,
): boolean {
	const platformCfg = platformConfigFor(cfg, platform);
	if (!platformCfg) return false;
	if (platformCfg.homeChannel && platformCfg.homeChannel === chatId) return true;
	if (platformCfg.allowedChats?.includes(chatId)) return true;
	return origin?.platform === platform && origin.chatId === chatId && isAuthorizedOrigin(cfg, origin);
}

export function createDeliverValidator(
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
				if (!isAllowedDeliverChat(cfg, platform, explicit[2], origin)) {
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
	return `Cron: ${job.name}\n———\n${content}`;
}

/**
 * The platform deliverer installed at the `@lunr/cron-delivery` bridge.
 * Every target is attempted; the first error is returned (null on success).
 */
export function createPlatformDeliverer(
	adapters: Map<string, PlatformAdapter>,
	config: GatewayConfig | (() => GatewayConfig),
): DeliveryBridge {
	const getConfig = typeof config === "function" ? config : () => config;
	return async (job, content) => {
		const targets = job.deliver
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		let firstError: string | null = null;
		for (const target of targets) {
			if (target === "local") continue; // output file already written by the scheduler
			const cfg = getConfig();
			const resolved = resolveTarget(target, job, cfg);
			if (typeof resolved === "string") {
				firstError ??= resolved;
				continue;
			}
			if (!isAllowedDeliverChat(cfg, resolved.platform, resolved.chatId, job.origin)) {
				firstError ??= `deliver target "${target}" is not an allowed chat for ${resolved.platform}`;
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
					const live = getConfig();
					const current = resolveTarget(target, job, live);
					if (typeof current === "string") throw new Error(current);
					if (
						current.platform !== resolved.platform ||
						current.chatId !== resolved.chatId ||
						current.threadId !== resolved.threadId
					)
						throw new Error("cron delivery destination changed");
					if (target === "origin" && !isAuthorizedOrigin(live, job.origin)) {
						throw new Error("cron origin requester access revoked; use /cron rebind");
					}
					if (!isAllowedDeliverChat(live, resolved.platform, resolved.chatId, job.origin))
						throw new Error(`deliver target "${target}" is not an allowed chat for ${resolved.platform}`);
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
 * stored jobs — jobs can be created later from chats. stop() cancels admitted work, awaits session cleanup and releases the lease last.
 */
export function startGatewayCron(options: GatewayCronOptions): { stop(): Promise<void>; intervalMs: number } {
	const { adapters } = options;
	const getConfig = options.getConfig ?? loadGatewayConfig;
	const sessionFactory = options.sessionFactory ?? defaultCronSessionFactory;
	const platformDeliverer = createPlatformDeliverer(adapters, getConfig);

	// One budget covers setup, owned prompt cancellation and session settlement.
	const jobTimeoutMs = options.jobTimeoutMs ?? 5 * 60 * 1000;

	// Reject deliver targets that are not local, origin, a configured home channel,
	// or an explicit chat in the platform allowlist / the job's origin.
	setCronDeliverValidator((deliver, origin) => createDeliverValidator(getConfig())(deliver, origin));

	// Retain the compatibility delivery bridge for integrations.
	(globalThis as Record<symbol, unknown>)[DELIVERY_BRIDGE_SYMBOL] = platformDeliverer;

	const runJob = async (prompt: string, job: CronJob, signal: AbortSignal): Promise<string> => {
		const fallbacks = options.fallbackModels ?? (await readCronFallbackModels());
		const candidates: Array<CronModelRef | undefined> = [undefined, ...fallbacks];
		const errors: string[] = [];
		beginCronFire();
		try {
			for (const candidate of candidates) {
				signal.throwIfAborted();
				const label = candidate ? `${candidate.provider}/${candidate.modelId}` : "default model";
				let session: BridgeSession | undefined;
				let dispatched = false;
				try {
					session = await sessionFactory(job, candidate);
					signal.throwIfAborted();
					if (!session.promptWithCompletion) throw new Error("cron session lacks owned prompt admission");
					dispatched = true;
					const result = await session.promptWithCompletion(prompt, { source: "extension", signal });
					const text = extractFinalText(result.messages);
					// The marker lands in the output file (the audit trail); [SILENT] as
					// the last line still suppresses delivery (scheduler isSilent check).
					return candidate ? `[fell back to ${label}]\n${text}` : text;
				} catch (err) {
					errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
					if (dispatched || signal.aborted) throw new Error(errors.join(" | "));
				} finally {
					if (session) {
						// The factory owns this fresh session, including extension-queued follow-ups.
						await session.drain?.();
						await shutdownBridgeSession(session, "quit");
					}
				}
			}
			throw new Error(errors.join(" | ") || "no model candidates");
		} finally {
			endCronFire();
		}
	};

	const deliverResult = async (job: CronJob, content: string): Promise<void> => {
		// Keep delivery bound to this operator even if another session changes a bridge.
		const err = await platformDeliverer(job, content);
		if (err) throw new Error(err);
	};

	const scheduler = startScheduler({ runJob, deliverResult, intervalMs: options.intervalMs, jobTimeoutMs });
	return { stop: () => scheduler.stop(), intervalMs: options.intervalMs ?? 60_000 };
}
