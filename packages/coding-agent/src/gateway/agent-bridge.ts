/**
 * lunR: gateway agent bridge.
 *
 * Owns the sessionKey → AgentSession mapping: an LRU cache (cap 20) over
 * live sessions, backed by store.ts so conversations survive daemon restarts
 * (a stored sessionFile is reopened via SessionManager.open, which
 * createAgentSession restores history from; a missing file starts fresh with
 * a one-line warning).
 *
 * New sessions replicate main.ts's headless wiring: SettingsManager +
 * DefaultResourceLoader with the builtin extension factories + the three
 * lunr bridges, then bindExtensions({ mode: "print" }) like print-mode.
 *
 * Busy guard: one turn per session at a time. Messages arriving mid-turn are
 * queued (cap 5, oldest dropped with a notice) and drained FIFO as a single
 * concatenated follow-up turn once the running turn ends; runTurn returns
 * the QUEUED sentinel for those, and the follow-up turn's result is
 * delivered via callbacks.onFollowUpResult.
 *
 * Streaming: subscribes to session events and converts cumulative
 * message_update snapshots into deltas for callbacks.onDelta.
 *
 * isGatewayTurn()/runDepth: incremented around every prompt() so Phase 4
 * (cron↔gateway delivery) and extensions can detect they run inside a
 * gateway turn and refuse self-scheduling. Every prompt() also runs inside
 * runWithOrigin(source, ...) (core/cron/origin-context) so tools executing
 * during the turn — e.g. the `cron` tool's create action — can read the chat
 * the message came from and stamp it as the job's delivery origin.
 */

import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../core/agent-session.ts";
import { runWithOrigin } from "../core/cron/origin-context.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { getSession, putSession, removeSession, touchSession } from "./store.ts";
import type { MessageEvent, SessionSource } from "./types.ts";

/** runTurn resolves with this when the message was queued behind a running turn. */
export const QUEUED = "__lunr_gateway_queued__";

const CACHE_CAP = 20;
const QUEUE_CAP = 5;

let runDepth = 0;

/** True while a gateway turn's prompt() is in flight. */
export function isGatewayTurn(): boolean {
	return runDepth > 0;
}

export function gatewayRunDepth(): number {
	return runDepth;
}

export interface TurnCallbacks {
	/** Assistant text delta during streaming (converted from cumulative snapshots). */
	onDelta?: (delta: string) => void;
	/** Final text of a drained-queue follow-up turn (deliver it like a normal reply). */
	onFollowUpResult?: (text: string) => void;
	/** Error from a drained-queue follow-up turn. */
	onError?: (message: string) => void;
}

export interface BridgeSessionStatus {
	busy: boolean;
	queueDepth: number;
	createdAt?: string;
}

/**
 * Structural session shape the bridge needs — satisfied by AgentSession,
 * fakeable in tests.
 */
export interface BridgeSession {
	prompt(text: string, options?: { source?: "extension" }): Promise<void>;
	abort(): Promise<void> | void;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly state: { messages: AgentMessage[] };
	dispose?(): void;
	readonly sessionManager?: {
		getSessionId(): string;
		getSessionFile(): string | undefined;
	};
}

export type SessionFactory = (key: string, reopen: { sessionFile: string } | undefined) => Promise<BridgeSession>;

interface CacheEntry {
	session: BridgeSession;
	busy: boolean;
	queue: MessageEvent[];
	dropped: number;
}

/**
 * Default factory: headless session with the builtin extensions, mirroring
 * main.ts (minus TUI) + print-mode's bindExtensions.
 *
 * The heavy wiring is imported LAZILY: a static import of
 * builtin-extensions/index.ts here would pull the whole extension + TUI
 * graph into every consumer of this module (router tests, `gateway status`)
 * and trip the known ashxj-tui ↔ package-barrel cycle (see AGENTS.md
 * "Barrel-import guard"). Loading it on first session creation keeps module
 * import light and matches how main.ts loads it in the real CLI.
 */
async function defaultSessionFactory(key: string, reopen: { sessionFile: string } | undefined): Promise<AgentSession> {
	const [
		{ builtinExtensions },
		{ getAgentDir },
		{ registerCustomizeBridge },
		{ registerMemoryCapBridge },
		{ registerModelTierBridge },
		{ DefaultResourceLoader },
		{ createAgentSession },
		{ SessionManager },
		{ SettingsManager },
	] = await Promise.all([
		import("../builtin-extensions/index.ts"),
		import("../config.ts"),
		import("../core/customize.ts"),
		import("../core/memory-cap.ts"),
		import("../core/model-tiers.ts"),
		import("../core/resource-loader.ts"),
		import("../core/sdk.ts"),
		import("../core/session-manager.ts"),
		import("../core/settings-manager.ts"),
	]);
	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	// Same bridges main.ts registers before extensions load.
	registerModelTierBridge(settingsManager);
	registerMemoryCapBridge(settingsManager);
	registerCustomizeBridge(settingsManager);

	let sessionManager: SessionManager;
	if (reopen && existsSync(reopen.sessionFile)) {
		sessionManager = SessionManager.open(reopen.sessionFile);
	} else {
		if (reopen) {
			console.warn(`[gateway] stored session file missing for ${key}; starting a fresh session`);
		}
		sessionManager = SessionManager.create(cwd);
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [...builtinExtensions],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager,
		settingsManager,
		resourceLoader,
	});
	await session.bindExtensions({
		mode: "print",
		onError: (err) => console.error(`[gateway] extension error (${err.extensionPath}): ${err.error}`),
	});
	return session;
}

/** Final assistant text, print-mode style; throws on error/aborted stop. */
function extractFinalText(session: BridgeSession): string {
	const messages = session.state.messages;
	const last = messages[messages.length - 1];
	if (last?.role !== "assistant") return "";
	const assistant = last as AssistantMessage;
	if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
		throw new Error(assistant.errorMessage || `Request ${assistant.stopReason}`);
	}
	let text = "";
	for (const content of assistant.content) {
		if (content.type === "text") text += content.text;
	}
	return text;
}

export class AgentBridge {
	private readonly cap: number;
	private readonly sessionFactory: SessionFactory;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly creating = new Map<string, Promise<CacheEntry>>();

	constructor(options: { cacheCap?: number; sessionFactory?: SessionFactory } = {}) {
		this.cap = options.cacheCap ?? CACHE_CAP;
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
	}

	/**
	 * Run one conversational turn. Resolves with the final assistant text, or
	 * the QUEUED sentinel when the session was busy (router must not reply).
	 */
	async runTurn(key: string, event: MessageEvent, callbacks: TurnCallbacks = {}): Promise<string> {
		const entry = await this.getOrCreate(key);
		if (entry.busy) {
			if (entry.queue.length >= QUEUE_CAP) {
				entry.queue.shift();
				entry.dropped++;
			}
			entry.queue.push(event);
			return QUEUED;
		}
		entry.busy = true;
		let result: string;
		try {
			result = await this.runPrompt(entry, event.text, callbacks, event.source);
		} catch (err) {
			entry.busy = false;
			throw err;
		}
		touchSession(key);
		// Drain queued messages as one follow-up turn, fire-and-forget. The busy
		// flag stays set until the queue is empty so turn ordering is strict;
		// the follow-up result arrives via callbacks.onFollowUpResult.
		void this.drainQueue(entry, callbacks).finally(() => {
			entry.busy = false;
		});
		return result;
	}

	async abort(key: string): Promise<void> {
		await this.cache.get(key)?.session.abort();
	}

	/** Drop the cached session (disposing it) and forget the store entry (/new, /reset). */
	reset(key: string): void {
		const entry = this.cache.get(key);
		if (entry) {
			this.cache.delete(key);
			entry.session.dispose?.();
		}
		removeSession(key);
	}

	getStatus(key: string): BridgeSessionStatus {
		const entry = this.cache.get(key);
		return {
			busy: entry?.busy ?? false,
			queueDepth: entry?.queue.length ?? 0,
			createdAt: getSession(key)?.createdAt,
		};
	}

	/** One prompt → final text. Increments runDepth; streams deltas when asked. */
	private async runPrompt(
		entry: CacheEntry,
		text: string,
		callbacks: TurnCallbacks,
		source: SessionSource,
	): Promise<string> {
		const { session } = entry;
		let unsubscribe: (() => void) | undefined;
		if (callbacks.onDelta) {
			const onDelta = callbacks.onDelta;
			let streamedLen = 0;
			unsubscribe = session.subscribe((event: AgentSessionEvent) => {
				if (event.type !== "message_update") return;
				const assistantEvent = event.assistantMessageEvent;
				if (assistantEvent.type !== "text_delta") return;
				let full = "";
				for (const content of assistantEvent.partial.content) {
					if (content.type === "text") full += content.text;
				}
				if (full.length < streamedLen) streamedLen = 0; // new assistant message (tool-call boundary)
				if (full.length > streamedLen) {
					onDelta(full.slice(streamedLen));
					streamedLen = full.length;
				}
			});
		}
		runDepth++;
		try {
			// AsyncLocalStorage origin: tools executing during this turn (e.g. the
			// `cron` tool) can read the chat the message came from. Propagates
			// through the awaited prompt() call tree.
			await runWithOrigin(
				{
					platform: source.platform,
					chatId: source.chatId,
					threadId: source.threadId,
					chatType: source.chatType,
				},
				() => session.prompt(text, { source: "extension" }),
			);
		} finally {
			runDepth--;
			unsubscribe?.();
		}
		return extractFinalText(session);
	}

	/** Drain the queue FIFO: all queued messages become one concatenated turn. */
	private async drainQueue(entry: CacheEntry, callbacks: TurnCallbacks): Promise<void> {
		while (entry.queue.length > 0) {
			const items = entry.queue.splice(0);
			const parts = items.map((item) => item.text);
			if (entry.dropped > 0) {
				parts.unshift(`[gateway: ${entry.dropped} earlier message(s) were dropped — the queue was full]`);
				entry.dropped = 0;
			}
			try {
				// Follow-up turns are final-only: no streaming callbacks. The origin
				// is the chat of the latest queued message.
				const text = await this.runPrompt(entry, parts.join("\n\n"), {}, items[items.length - 1].source);
				callbacks.onFollowUpResult?.(text);
			} catch (err) {
				callbacks.onError?.(err instanceof Error ? err.message : String(err));
				return;
			}
		}
	}

	private async getOrCreate(key: string): Promise<CacheEntry> {
		const cached = this.cache.get(key);
		if (cached) {
			// LRU refresh
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached;
		}
		// Coalesce concurrent creation for the same key.
		let pending = this.creating.get(key);
		if (!pending) {
			pending = this.createEntry(key);
			this.creating.set(key, pending);
			try {
				await pending;
			} finally {
				this.creating.delete(key);
			}
		}
		return pending;
	}

	private async createEntry(key: string): Promise<CacheEntry> {
		const stored = getSession(key);
		const session = await this.sessionFactory(key, stored ? { sessionFile: stored.sessionFile } : undefined);
		const sessionFile = session.sessionManager?.getSessionFile();
		if (sessionFile) {
			putSession(key, { sessionId: session.sessionManager?.getSessionId() ?? key, sessionFile });
		}
		const entry: CacheEntry = { session, busy: false, queue: [], dropped: 0 };
		this.cache.set(key, entry);
		while (this.cache.size > this.cap) {
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey === undefined) break;
			const oldest = this.cache.get(oldestKey);
			this.cache.delete(oldestKey);
			oldest?.session.dispose?.();
		}
		return entry;
	}
}
