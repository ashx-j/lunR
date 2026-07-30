/**
 * lunR: gateway types (Phase 2a of the cron/gateway roadmap).
 *
 * `lunr gateway` is a long-running daemon connecting lunR to chat platforms.
 * Platform adapters (Telegram in Phase 2b, Discord in Phase 3) implement
 * PlatformAdapter; everything else in src/gateway/ is platform-agnostic.
 */

export type ChatType = "dm" | "group" | "channel" | "thread";

/** Where an inbound message came from. Also identifies the session it routes to. */
export interface SessionSource {
	platform: string;
	chatId: string;
	chatType: ChatType;
	userId: string;
	userName?: string;
	threadId?: string;
	/** Adapter-supplied: the user carries a platform-side authorized role (e.g. bot admin). */
	roleAuthorized?: boolean;
}

/** An inbound chat message. */
export interface MessageEvent {
	text: string;
	source: SessionSource;
	messageId: string;
	/** Text of the message this one replies to, when the platform exposes it. */
	replyToText?: string;
	/**
	 * Adapter-supplied extras. Reserved keys:
	 * - mentionedBot === true: the message explicitly @-mentions the bot
	 *   (group gating + requireMention rely on this).
	 */
	metadata?: Record<string, unknown>;
}

export interface SendResult {
	success: boolean;
	messageId?: string;
	error?: string;
	/** True when the failure is worth retrying (rate limit, transient network). */
	retryable?: boolean;
}

/** A single inline button. */
export interface Button {
	id: string;
	label: string;
}

/** Platform-agnostic button layout: rows of buttons. */
export type ButtonSpec = Button[][];

export interface SendOptions {
	/** Platform message id to reply to. */
	replyTo?: string;
	threadId?: string;
	/** Inline keyboard attached to the message. */
	buttons?: ButtonSpec;
}

/** An inbound button-click / inline-keyboard callback. */
export interface CallbackEvent {
	source: SessionSource;
	messageId: string;
	buttonId: string;
	/** Platform callback id (e.g. Telegram callback_query id or Discord interaction id). */
	callbackId: string;
	/** Optional payload carried by the button. */
	data?: string;
}

/**
 * A chat platform connection. Adapters own polling/webhook lifecycles and
 * push inbound messages to the handler registered via onMessage().
 */
export interface PlatformAdapter {
	readonly platform: string;
	/** Max characters (UTF-16 code units) per outbound message; router splits to fit. */
	readonly maxMessageLength: number;
	connect(): Promise<boolean>;
	disconnect(): Promise<void>;
	send(chatId: string, text: string, opts?: SendOptions): Promise<SendResult>;
	sendButtons(chatId: string, text: string, buttons: ButtonSpec, opts?: SendOptions): Promise<SendResult>;
	editMessage(chatId: string, messageId: string, text: string, opts?: SendOptions): Promise<SendResult>;
	sendTyping(chatId: string, threadId?: string): Promise<void>;
	onMessage(handler: (event: MessageEvent) => void): void;
	onCallback(handler: (event: CallbackEvent) => void): void;
	answerCallback(event: CallbackEvent): Promise<void>;
}
