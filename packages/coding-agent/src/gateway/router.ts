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
 *      silence-filtered and folded INTO the streaming preview (edit, plus
 *      continuation chunks when the preview was truncated) — no preview +
 *      final double-send. Without streaming it is split (text.ts) and sent
 *      sequentially, the first chunk replying to the triggering message.
 * Errors surface as a compact "⚠ <one-line>" — never a stack trace.
 */

import { existsSync } from "node:fs";

import { type BridgeSession, type BridgeSessionStatus, QUEUED, type TurnCallbacks } from "./agent-bridge.ts";
import { registerGatewayApprovalHandler, runWithApprovalContext } from "./approval.ts";
import { isAuthorized } from "./authz.ts";
import { CHAT_COMMANDS, runChatCommand, sendCommandReply } from "./commands.ts";
import { type GatewayConfig, gatewayConfigPath, loadGatewayConfig, platformConfigFor } from "./config.ts";
import type { PairingStore } from "./pairing.ts";
import { buildSessionKey } from "./session-keys.ts";
import { applySilenceFilter, StreamConsumer } from "./stream.ts";
import { splitMessage } from "./text.ts";
import type { MessageEvent, PlatformAdapter } from "./types.ts";

/** Structural bridge shape (AgentBridge satisfies it; tests fake it). */
export interface BridgeLike {
	runTurn(key: string, event: MessageEvent, callbacks: TurnCallbacks): Promise<string>;
	abort(key: string): Promise<void> | void;
	reset(key: string): void | Promise<void>;
	getStatus(key: string): BridgeSessionStatus;
	getSession(key: string): Promise<BridgeSession | null>;
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

	// lunr: headless gateway sessions must prompt for mutating tools in manual mode.
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

	async function sendError(adapter: PlatformAdapter, event: MessageEvent, message: string): Promise<void> {
		await adapter.send(event.source.chatId, `⚠ ${oneLine(message)}`, {
			replyTo: event.messageId,
			threadId: event.source.threadId,
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
			`Your lunR pairing code: ${formatPairingCode(code)} — ask the owner to run: lunr gateway pair approve ${source.platform} ${formatPairingCode(code)}`,
			{ replyTo: event.messageId, threadId: source.threadId },
		);
		return true;
	}

	/** Step 3: command registry. Returns true when the event was consumed. */
	async function handleSlash(adapter: PlatformAdapter, event: MessageEvent, key: string): Promise<boolean> {
		const text = event.text.trim();
		if (!text.startsWith("/")) return false;
		const firstToken = text.split(/\s+/, 1)[0].toLowerCase();
		const commandWord = firstToken.split("@")[0].slice(1);
		const args = text.slice(firstToken.length).trim();
		const cmd = CHAT_COMMANDS.find((c) => c.name === commandWord || c.aliases?.includes(commandWord));
		if (!cmd) {
			// Unknown slash command: DM → normal text, group → ignore.
			return event.source.chatType !== "dm";
		}
		const ctx = {
			event,
			key,
			adapter,
			bridge,
			args,
			reply: (message: string) => sendCommandReply(adapter, event, message),
		};
		return runChatCommand(cmd, ctx);
	}

	/** Step 4 delivery: silence filter → split → sequential send.
	 *
	 * When a streaming preview message exists (editMessageId), the final text
	 * is folded INTO it instead of sent as a duplicate: non-truncated previews
	 * get a final edit (covers silence-marker stripping), truncated previews
	 * are edited to chunk 1 and the remaining chunks are sent as follow-ups. */
	async function deliver(
		adapter: PlatformAdapter,
		event: MessageEvent,
		text: string,
		opts: { reply: boolean; editMessageId?: string; previewTruncated?: boolean },
	): Promise<void> {
		const filtered = applySilenceFilter(text);
		if (filtered === null) return;
		const chunks = splitMessage(filtered, adapter.maxMessageLength);
		let startIndex = 0;
		if (opts.editMessageId) {
			if (!opts.previewTruncated) {
				// Preview already holds the whole text: one final edit, no new message.
				await adapter.editMessage(event.source.chatId, opts.editMessageId, filtered);
				return;
			}
			// Preview was truncated: upgrade it to the first full chunk.
			await adapter.editMessage(event.source.chatId, opts.editMessageId, chunks[0]);
			startIndex = 1;
		}
		for (let index = startIndex; index < chunks.length; index++) {
			const result = await adapter.send(event.source.chatId, chunks[index], {
				replyTo: opts.reply && index === 0 ? event.messageId : undefined,
				threadId: event.source.threadId,
			});
			if (!result.success) {
				console.error(`[gateway] send failed on ${adapter.platform}: ${result.error ?? "unknown error"}`);
				return;
			}
		}
	}

	async function runTurn(
		adapter: PlatformAdapter,
		event: MessageEvent,
		key: string,
		cfg: GatewayConfig,
	): Promise<void> {
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
					await adapter.editMessage(event.source.chatId, messageId, text);
				},
				intervalMs: cfg.streaming.editIntervalMs,
				threshold: cfg.streaming.bufferThreshold,
				maxPreview: adapter.maxMessageLength,
			});
		}

		const callbacks: TurnCallbacks = {
			onDelta: consumer ? (delta) => consumer.push(delta) : undefined,
			onFollowUpResult: (text) => {
				void deliver(adapter, event, text, { reply: false });
			},
			onError: (message) => {
				void sendError(adapter, event, message);
			},
		};

		const result = await runWithApprovalContext({ key, adapter, source: event.source }, () =>
			bridge.runTurn(key, event, callbacks),
		);
		if (result === QUEUED) return; // queued behind a running turn: no reply
		if (consumer) await consumer.finalize();
		await deliver(adapter, event, result, {
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
			try {
				if (isGroupGated(event, cfg)) return;
				if (await isDenied(adapter, event, cfg)) return;
				const key = buildSessionKey(event.source, { groupSessionsPerUser: cfg.groupSessionsPerUser });
				if (await handleSlash(adapter, event, key)) return;
				await adapter.sendTyping(event.source.chatId, event.source.threadId).catch(() => {});
				await runTurn(adapter, event, key, cfg);
			} catch (err) {
				await sendError(adapter, event, err instanceof Error ? err.message : String(err)).catch(() => {});
			}
		},
	};
}
