/**
 * lunR: gateway router.
 *
 * Every inbound MessageEvent flows through handleEvent:
 *   1. group gating (allowedChats / freeResponseChats / requireMention,
 *      with adapter-supplied metadata.mentionedBot)
 *   2. authorization (authz.ts); denied DMs get a pairing code when the
 *      behavior is "pair" and the user isn't rate-limited
 *   3. command registry (/new, /undo, /redo, /model, /sessions, /title,
 *      /context, /compact, /thinking, /stop, /status, /help, /whoami)
 *   4. normal path: bridge.runTurn with a StreamConsumer when streaming is
 *      enabled and the adapter supports edit; the final text is
 *      silence-filtered and folded into a successful streaming preview edit.
 *      Failed final edits and ordinary answers enter the durable outbox, which
 *      acknowledges chunks in order and retries by destination.
 * Errors surface as a compact "⚠ <one-line>" — never a stack trace.
 */

import { existsSync } from "node:fs";
import { type BridgeSession, type BridgeSessionStatus, QUEUED, type TurnCallbacks } from "./agent-bridge.ts";
import { registerGatewayApprovalHandler, runWithApprovalContext } from "./approval.ts";
import { isAuthorized, requireAuthorized } from "./authz.ts";
import { CHAT_COMMANDS, runChatCommand, sendCommandReply } from "./commands.ts";
import { type GatewayConfig, gatewayConfigPath, loadGatewayConfig, platformConfigFor } from "./config.ts";
import { bindConversation, conversationBinding } from "./conversations.ts";
import { resolveWithinRoots } from "./mobile-commands.ts";
import type { PairingStore } from "./pairing.ts";
import {
	acceptGatewayInput,
	gatewayEpoch,
	invalidateGatewayDialogs,
	queueGatewayText,
	rememberGatewayRole,
} from "./presenter.ts";
import { buildSessionKey } from "./session-keys.ts";
import { getSession as getStoredSession } from "./store.ts";
import { applySilenceFilter, StreamConsumer } from "./stream.ts";
import { splitMessage } from "./text.ts";
import type { MessageEvent, PlatformAdapter } from "./types.ts";

/** Structural bridge shape (AgentBridge satisfies it; tests fake it). */
export interface BridgeLike {
	runTurn(key: string, event: MessageEvent, callbacks: TurnCallbacks): Promise<string>;
	abort(key: string): Promise<void> | void;
	reset(key: string): void | Promise<void>;
	getStatus(key: string): BridgeSessionStatus;
	getSession(key: string, create?: boolean): Promise<BridgeSession | null>;
	peekSession?(key: string): BridgeSession | undefined;
	switchSession(key: string, sessionFile: string): Promise<void>;
	undo(key: string): Promise<{ userText: string }>;
	redo(key: string): Promise<void>;
}

export interface RouterDeps {
	adapters: Map<string, PlatformAdapter>;
	cfg: GatewayConfig;
	pairing: PairingStore;
	bridge: BridgeLike;
	/** Reload gateway.json on every inbound event so CLI config edits (e.g. pair approve) are picked up by the running daemon. */
	reloadConfig?: boolean;
	remoteControls?: boolean;
}

export interface Router {
	handleEvent(event: MessageEvent): Promise<void>;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function formatPairingCode(code: string): string {
	return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function mentionedBot(event: MessageEvent): boolean {
	return event.metadata?.mentionedBot === true;
}

export function createRouter(deps: RouterDeps): Router {
	const { adapters, cfg: initialCfg, pairing, bridge, reloadConfig } = deps;

	// Headless gateway sessions still prompt for large subagent launches in yolo mode.
	registerGatewayApprovalHandler();

	/** Reload gateway.json on every inbound event so CLI edits (e.g. pair approve) take effect immediately. */
	function freshCfg(): GatewayConfig {
		if (!reloadConfig) return initialCfg;
		try {
			if (existsSync(gatewayConfigPath())) {
				return loadGatewayConfig();
			}
		} catch {
			// fall through to initial config
		}
		return initialCfg;
	}

	async function sendError(
		adapter: PlatformAdapter,
		event: MessageEvent,
		key: string,
		cfg: GatewayConfig,
		message: string,
		epoch: number,
	): Promise<void> {
		await queueGatewayText(key, event.source, adapter, `⚠ ${oneLine(message)}`, {
			kind: "notice",
			replyTo: event.messageId,
			cfg,
			epoch,
		});
	}

	/** Step 1: group-chat early gating. Returns true when the event must be dropped. */
	function isGroupGated(event: MessageEvent, cfg: GatewayConfig): boolean {
		const { source } = event;
		if (source.chatType === "dm") return false;
		const platformCfg = platformConfigFor(cfg, source.platform);
		if (!platformCfg) return true;
		const freeResponse = platformCfg.freeResponseChats.includes(source.chatId);
		if (
			platformCfg.allowedChats.length > 0 &&
			!platformCfg.allowedChats.includes(source.chatId) &&
			!freeResponse &&
			!mentionedBot(event)
		) {
			return true;
		}
		if (platformCfg.requireMention && !freeResponse && !mentionedBot(event)) {
			return true;
		}
		return false;
	}

	/** Step 2: authorization; handles the denied-DM pairing flow. Returns true when denied. */
	async function isDenied(adapter: PlatformAdapter, event: MessageEvent, cfg: GatewayConfig): Promise<boolean> {
		if (isAuthorized(event.source, cfg, pairing)) return false;
		const { source } = event;
		if (source.chatType !== "dm") return true; // denied group: silent
		if (cfg.unauthorizedDmBehavior !== "pair") return true;
		const code = pairing.issueCode(source.platform, source.userId);
		if (code === null) return true; // rate-limited or pending list full: stay silent
		await adapter.send(
			source.chatId,
			`Your lunR pairing code: ${formatPairingCode(code)}. On the computer running lunr, approve access with: lunr gateway pair approve ${source.platform} ${formatPairingCode(code)}. Approval grants full gateway access, including local projects and saved sessions.`,
			{ replyTo: event.messageId, threadId: source.threadId },
		);
		return true;
	}

	function workspaceReadiness(event: MessageEvent, key: string, cfg: GatewayConfig): string | undefined {
		if (getStoredSession(key) || conversationBinding(key)?.cwd) return undefined;
		const root = cfg.defaultProject;
		if (!root) return "No default project selected. Use /project to choose an approved folder.";
		try {
			const cwd = resolveWithinRoots(root, cfg.projectRoots ?? []);
			bindConversation(key, event.source, { cwd, owner: event.source.userId });
			return undefined;
		} catch {
			return "Default project is no longer an approved folder. Use /project to choose an approved folder.";
		}
	}

	/** Step 3: command registry. Returns true when the event was consumed. */
	async function handleSlash(adapter: PlatformAdapter, event: MessageEvent, key: string): Promise<boolean> {
		const text = event.text.trim();
		if (!text.startsWith("/")) return false;
		const firstToken = text.split(/\s+/, 1)[0].toLowerCase();
		const commandWord = firstToken.split("@")[0].slice(1);
		const args = text.slice(firstToken.length).trim();
		if (deps.remoteControls) {
			const { handleMobileCommand, cancelMobileTransfer } = await import("./mobile-commands.ts");
			if (["stop", "stopall", "new", "cancel"].includes(commandWord)) cancelMobileTransfer(key);
			if (commandWord === "cancel") {
				invalidateGatewayDialogs(key);
				await adapter.send(event.source.chatId, "Cancelled the pending selection or transfer.", {
					threadId: event.source.threadId,
				});
				return true;
			}
			const consumed = await runWithApprovalContext({ key, adapter, source: event.source }, () =>
				handleMobileCommand({ key, event, adapter, bridge, cfg: freshCfg() }, commandWord, args),
			);
			if (consumed) return true;
			if (!event.text.startsWith("/")) return false;
		}
		if (commandWord === "start") {
			const issue = deps.remoteControls ? workspaceReadiness(event, key, freshCfg()) : undefined;
			if (issue) {
				await sendCommandReply(adapter, event, issue);
				return true;
			}
			try {
				const session = await bridge.getSession(key, true);
				const models = await session?.modelRuntime.getAvailable();
				if (!models?.length)
					await sendCommandReply(
						adapter,
						event,
						"No authenticated model available. Use /login on your computer, then try /start again.",
					);
				else if (
					!session?.model ||
					!models.some((model) => model.id === session.model?.id && model.provider === session.model.provider)
				)
					await sendCommandReply(adapter, event, "No available model selected. Use /model here to choose one.");
				else
					await sendCommandReply(
						adapter,
						event,
						"Ready. Send a message to begin, or use /model to choose a model.",
					);
			} catch {
				await sendCommandReply(
					adapter,
					event,
					"Session setup failed. Run lunr gateway doctor on your computer, then try /start again.",
				);
			}
			return true;
		}
		if (deps.remoteControls && commandWord === "model") {
			const issue = workspaceReadiness(event, key, freshCfg());
			if (issue) {
				await sendCommandReply(adapter, event, issue);
				return true;
			}
		}
		const cmd = CHAT_COMMANDS.find((c) => c.name === commandWord || c.aliases?.includes(commandWord));
		if (!cmd) {
			return event.source.chatType !== "dm";
		}
		const ctx = {
			event,
			key,
			adapter,
			bridge,
			cfg: freshCfg(),
			args,
			reply: (message: string) => sendCommandReply(adapter, event, message),
		};
		return runWithApprovalContext({ key, adapter, source: event.source }, () => runChatCommand(cmd, ctx));
	}

	/** A successful preview is finalized by edit; failed edits fall back to a durable full reply. */
	async function deliver(
		adapter: PlatformAdapter,
		event: MessageEvent,
		text: string,
		key: string,
		cfg: GatewayConfig,
		opts: { reply: boolean; editMessageId?: string; previewTruncated?: boolean },
	): Promise<void> {
		const filtered = applySilenceFilter(text);
		if (filtered === null) return;
		if (opts.editMessageId) {
			const chunks = splitMessage(filtered, adapter.maxMessageLength);
			const edit = await adapter
				.editMessage(event.source.chatId, opts.editMessageId, opts.previewTruncated ? chunks[0] : filtered)
				.catch(() => ({ success: false }));
			if (edit.success) {
				if (!opts.previewTruncated) return;
				await queueGatewayText(key, event.source, adapter, chunks.slice(1).join(""), {
					kind: "result",
					cfg,
					chunks: chunks.slice(1),
				});
				return;
			}
		}
		await queueGatewayText(key, event.source, adapter, filtered, {
			kind: "result",
			replyTo: opts.reply ? event.messageId : undefined,
			cfg,
		});
	}

	async function runTurn(
		adapter: PlatformAdapter,
		event: MessageEvent,
		key: string,
		cfg: GatewayConfig,
	): Promise<void> {
		const epoch = gatewayEpoch(key);
		const streaming = cfg.streaming.enabled && typeof adapter.editMessage === "function";
		let consumer: StreamConsumer | undefined;
		if (streaming) {
			consumer = new StreamConsumer({
				sendInitial: async (text) => {
					const result = await adapter.send(event.source.chatId, text, {
						replyTo: event.messageId,
						threadId: event.source.threadId,
					});
					return result.success ? (result.messageId ?? null) : null;
				},
				edit: async (messageId, text) => {
					const result = await adapter.editMessage(event.source.chatId, messageId, text);
					if (!result.success) throw new Error(result.error ?? "Preview edit failed");
				},
				intervalMs: cfg.streaming.editIntervalMs,
				threshold: cfg.streaming.bufferThreshold,
				maxPreview: adapter.maxMessageLength,
			});
		}

		const callbacks: TurnCallbacks = {
			onDelta: consumer ? (delta) => consumer.push(delta) : undefined,
			onFollowUpResult: (text) => {
				void deliver(adapter, event, text, key, cfg, { reply: false }).catch((error) =>
					console.error("[gateway] follow-up delivery failed:", error),
				);
			},
			onError: (message) => {
				void sendError(adapter, event, key, cfg, message, epoch).catch((error) =>
					console.error("[gateway] error delivery failed:", error),
				);
			},
		};

		const result = await runWithApprovalContext({ key, adapter, source: event.source }, () =>
			bridge.runTurn(key, event, callbacks),
		);
		if (result === QUEUED) return; // queued behind a running turn: no reply
		if (consumer) await consumer.finalize();
		await deliver(adapter, event, result, key, cfg, {
			reply: !consumer,
			editMessageId: consumer?.sentMessageId ?? undefined,
			previewTruncated: consumer?.truncated ?? false,
		});
	}

	return {
		async handleEvent(event: MessageEvent): Promise<void> {
			const adapter = adapters.get(event.source.platform);
			if (!adapter) return;
			const cfg = freshCfg();
			const key = buildSessionKey(event.source, { groupSessionsPerUser: cfg.groupSessionsPerUser });
			const epoch = gatewayEpoch(key);
			try {
				if (isGroupGated(event, cfg)) return;
				rememberGatewayRole(key, event.source);
				if (await isDenied(adapter, event, cfg)) return;
				if (deps.remoteControls) {
					const binding = conversationBinding(key);
					if (binding?.owner) {
						requireAuthorized(event.source, cfg);
						if (binding.owner !== event.source.userId)
							throw new Error("This session belongs to a different user.");
					}
					bindConversation(key, event.source);
					if (acceptGatewayInput(key, event)) return;
				}
				if (await handleSlash(adapter, event, key)) return;
				const issue = deps.remoteControls ? workspaceReadiness(event, key, cfg) : undefined;
				if (issue) {
					await sendCommandReply(adapter, event, issue);
					return;
				}
				await adapter.sendTyping(event.source.chatId, event.source.threadId).catch(() => {});
				await runTurn(adapter, event, key, cfg);
			} catch (err) {
				await sendError(adapter, event, key, cfg, err instanceof Error ? err.message : String(err), epoch).catch(
					() => {},
				);
			}
		},
	};
}
