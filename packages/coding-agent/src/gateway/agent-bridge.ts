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
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSession, AgentSessionEvent, SessionStats } from "../core/agent-session.ts";
import type { CompactionResult } from "../core/compaction/index.ts";
import { runWithOrigin } from "../core/cron/origin-context.ts";
import type { ContextUsage, ToolDefinition } from "../core/extensions/types.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { createPermissionContext, deletePermissionContext } from "../core/permissions.ts";
import type { ReadonlySessionManager, SessionManager, SessionMessageEntry } from "../core/session-manager.ts";
import { processImage } from "../utils/image-process.ts";
import { getSession, putSession, removeSession, touchSession } from "./store.ts";
import type { InboundAttachment, MessageEvent, SessionSource } from "./types.ts";

function isUserMessageEntry(entry: { type: string }): entry is SessionMessageEntry {
	return entry.type === "message";
}

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
 * fakeable in tests. Expanded to support gateway slash commands.
 */
export interface BridgeSession {
	prompt(text: string, options?: { source?: "extension"; images?: ImageContent[] }): Promise<void>;
	abort(): Promise<void> | void;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly state: { messages: AgentMessage[] };
	dispose?(): void;
	readonly isStreaming: boolean;
	readonly isCompacting?: boolean;
	readonly model?: Model<any>;
	readonly modelRuntime: ModelRuntime;
	readonly thinkingLevel: ThinkingLevel;
	readonly messages: AgentMessage[];
	readonly systemPrompt: string;
	readonly sessionManager?: ReadonlySessionManager;

	getActiveToolNames(): string[];
	getToolDefinition(name: string): ToolDefinition | undefined;
	getAvailableThinkingLevels(): ThinkingLevel[];
	supportsThinking(): boolean;
	setThinkingLevel(level: ThinkingLevel): void;
	setModel(model: Model<any>): Promise<void>;
	compact(customInstructions?: string): Promise<CompactionResult>;
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>;
	getContextUsage(): ContextUsage | undefined;
	getSessionStats(): SessionStats;
	setSessionName(name: string): void;
}

export type SessionFactory = (key: string, reopen: { sessionFile: string } | undefined) => Promise<BridgeSession>;

interface CacheEntry {
	session: BridgeSession;
	busy: boolean;
	queue: MessageEvent[];
	dropped: number;
	unsubscribe?: () => void;
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
		{ loadAllBuiltinExtensions },
		{ getAgentDir },
		{ registerCustomizeBridge },
		{ registerMemoryCapBridge },
		{ getModelTiersBridge, registerModelTierBridge },
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

	// Services-first (mirrors main.ts): extension-registered providers (e.g.
	// ollama-cloud) must land in the shared ModelRuntime BEFORE session
	// creation — otherwise findInitialModel can't resolve the user's default
	// model and silently falls back to an arbitrary catalog provider (this
	// exact bug sent gateway turns to openrouter with no key → 401).
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: { extensionFactories: await loadAllBuiltinExtensions() },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager });
	getModelTiersBridge()?.setParentThinkingProvider(() => session.thinkingLevel);
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
	private cap: number;
	private readonly sessionFactory: SessionFactory;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly redoStack = new Map<string, string[]>();
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
			result = await this.runPrompt(entry, event.text, callbacks, event.source, event.attachments);
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

	/** Return the live session for a key, or null when none exists yet. */
	async getSession(key: string): Promise<BridgeSession | null> {
		const cached = this.cache.get(key);
		if (cached) return cached.session;
		if (!getSession(key)) return null;
		return (await this.getOrCreate(key)).session;
	}

	/** Switch the chat to a different persisted session file. */
	async switchSession(key: string, sessionFile: string): Promise<void> {
		const entry = this.cache.get(key);
		if (entry?.busy) {
			throw new Error("Session is busy — /stop first or wait");
		}
		if (entry) {
			const oldSessionId = entry.session.sessionManager?.getSessionId();
			entry.unsubscribe?.();
			this.cache.delete(key);
			entry.session.dispose?.();
			if (oldSessionId) deletePermissionContext(oldSessionId);
		}
		removeSession(key);
		this.redoStack.delete(key);

		const session = await this.sessionFactory(key, { sessionFile });
		const newFile = session.sessionManager?.getSessionFile();
		const newSessionId = session.sessionManager?.getSessionId();
		if (newFile) {
			putSession(key, { sessionId: newSessionId ?? key, sessionFile: newFile });
		}
		if (newSessionId) {
			createPermissionContext(newSessionId);
		}
		const newEntry: CacheEntry = { session, busy: false, queue: [], dropped: 0 };
		this.cache.set(key, newEntry);
		this._enforceCacheCap(key);
		newEntry.unsubscribe = this._subscribeToSession(key, newEntry);
	}

	/** Undo the last user turn and push the previous leaf onto the redo stack. */
	async undo(key: string): Promise<{ userText: string }> {
		const session = await this.getSession(key);
		if (!session) throw new Error("No session");
		if (session.isStreaming) throw new Error("Wait for the current response to finish");
		const branch = session.sessionManager?.getBranch() ?? [];
		let lastUserIndex = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (isUserMessageEntry(entry) && entry.message.role === "user") {
				lastUserIndex = i;
				break;
			}
		}
		if (lastUserIndex === -1) throw new Error("Nothing to undo");
		const lastUser = branch[lastUserIndex];
		if (!isUserMessageEntry(lastUser)) throw new Error("Nothing to undo");

		const leafId = session.sessionManager?.getLeafId() ?? null;
		let targetId: string;
		if (lastUser.id === leafId) {
			if (!lastUser.parentId) throw new Error("Nothing to undo");
			targetId = lastUser.parentId;
		} else {
			targetId = lastUser.id;
		}

		const result = await session.navigateTree(targetId, {});
		if (result.cancelled) throw new Error("Navigation cancelled");

		if (leafId) {
			const stack = this.redoStack.get(key) ?? [];
			stack.push(leafId);
			this.redoStack.set(key, stack);
		}

		return { userText: extractUserText(lastUser.message) };
	}

	/** Redo to the leaf saved by the most recent undo. */
	async redo(key: string): Promise<void> {
		const session = await this.getSession(key);
		if (!session) throw new Error("No session");
		if (session.isStreaming) throw new Error("Wait for the current response to finish");
		const stack = this.redoStack.get(key) ?? [];
		const targetId = stack.pop();
		if (!targetId) throw new Error("Nothing to redo");
		this.redoStack.set(key, stack);

		const result = await session.navigateTree(targetId, {});
		if (result.cancelled) {
			stack.push(targetId);
			this.redoStack.set(key, stack);
			throw new Error("Navigation cancelled");
		}
	}

	/** Test/debug hook: how many redo targets are saved for a key. */
	getRedoStackLength(key: string): number {
		return this.redoStack.get(key)?.length ?? 0;
	}

	/** Drop the cached session (disposing it) and forget the store entry (/new, /reset). */
	reset(key: string): void {
		const entry = this.cache.get(key);
		if (entry) {
			entry.unsubscribe?.();
			this.cache.delete(key);
			entry.session.dispose?.();
		}
		removeSession(key);
		this.redoStack.delete(key);
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
		attachments?: InboundAttachment[],
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
			// lunr: convert inbound image attachments to ImageContent for the model.
			// processImage normalizes + resizes under the inline 4.5MB base64 limit;
			// failures become bracketed text notes so the model explains the gap.
			const images: ImageContent[] = [];
			const notes: string[] = [];
			for (const attachment of attachments ?? []) {
				const bytes = Buffer.from(attachment.data, "base64");
				const processed = await processImage(new Uint8Array(bytes), attachment.mimeType);
				if (processed.ok) {
					images.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
					for (const hint of processed.hints) notes.push(hint);
				} else {
					notes.push(processed.message);
				}
			}
			const promptText = notes.length > 0 ? `${text}\n\n${notes.join(" ")}` : text;
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
				() => session.prompt(promptText, { source: "extension", ...(images.length ? { images } : {}) }),
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
			const attachments = items.flatMap((item) => item.attachments ?? []);
			if (entry.dropped > 0) {
				parts.unshift(`[gateway: ${entry.dropped} earlier message(s) were dropped — the queue was full]`);
				entry.dropped = 0;
			}
			try {
				// Follow-up turns are final-only: no streaming callbacks. The origin
				// is the chat of the latest queued message.
				const text = await this.runPrompt(
					entry,
					parts.join("\n\n"),
					{},
					items[items.length - 1].source,
					attachments,
				);
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
		const sessionId = session.sessionManager?.getSessionId();
		if (sessionFile) {
			putSession(key, { sessionId: sessionId ?? key, sessionFile });
		}
		if (sessionId) {
			createPermissionContext(sessionId);
		}
		const entry: CacheEntry = { session, busy: false, queue: [], dropped: 0, unsubscribe: undefined };
		this.cache.set(key, entry);
		this._enforceCacheCap(key);
		entry.unsubscribe = this._subscribeToSession(key, entry);
		return entry;
	}

	private _enforceCacheCap(protectedKey?: string): void {
		while (this.cache.size > this.cap) {
			let oldestKey: string | undefined;
			let oldest: CacheEntry | undefined;
			for (const [key, entry] of this.cache) {
				if (key === protectedKey) continue;
				if (entry.busy) continue;
				oldestKey = key;
				oldest = entry;
				break;
			}
			if (!oldest || !oldestKey) {
				// Every cached session is busy (or is the protected new entry);
				// grow the cap temporarily rather than killing an in-flight turn.
				this.cap = this.cache.size;
				break;
			}
			oldest.unsubscribe?.();
			this.cache.delete(oldestKey);
			oldest.session.dispose?.();
			const evictedSessionId = oldest.session.sessionManager?.getSessionId();
			if (evictedSessionId) deletePermissionContext(evictedSessionId);
		}
	}

	private _subscribeToSession(key: string, entry: CacheEntry): () => void {
		return entry.session.subscribe((event) => this._handleSessionEvent(key, event));
	}

	private _handleSessionEvent(key: string, event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message?.role === "user") {
			this.redoStack.delete(key);
		}
	}
}

function extractUserText(message: AgentMessage): string {
	let text = "";
	if ("content" in message && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (
				block &&
				typeof block === "object" &&
				"type" in block &&
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				text += block.text;
			}
		}
	}
	return text;
}
