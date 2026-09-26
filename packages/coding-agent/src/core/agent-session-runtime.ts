import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import * as processRegistry from "./process-registry.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionTransferError } from "./session-handoff.ts";
import { SessionManager } from "./session-manager.ts";
import { canonicalSessionPath, SessionOwnership } from "./session-ownership.ts";
import { getSubagentCancellation } from "./subagent-cancellation.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/** Host callback for rebinding process-global state to the applied runtime. */
export type AgentSessionRuntimeApplied = (result: CreateAgentSessionRuntimeResult) => void;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: (reason: SessionShutdownEvent["reason"]) => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly onRuntimeApplied?: AgentSessionRuntimeApplied;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private detached = false;
	private transferring = false;

	get isDetached(): boolean {
		return this.detached;
	}

	async releaseForTransfer(options: { stop?: boolean; signal?: AbortSignal } = {}): Promise<void> {
		options.signal?.throwIfAborted();
		if (this.detached) return;
		if (this.transferring) throw new SessionTransferError("Session transfer is already in progress.", "busy");
		this.transferring = true;
		this.session.setTransferring(true);
		const hasAttachedWork = () =>
			getSubagentCancellation(this.session.sessionId)?.hasActiveRuns() ||
			getSubagentCancellation(this.session.sessionFile ?? "")?.hasActiveRuns() ||
			processRegistry
				.list()
				.some(
					(entry) => entry.status !== "exited" && (!entry.sessionId || entry.sessionId === this.session.sessionId),
				);
		const busy = () =>
			this.session.isStreaming ||
			this.session.isCompacting ||
			this.session.isBashRunning ||
			this.session.isRetrying ||
			this.session.pendingMessageCount > 0;
		try {
			if (hasAttachedWork())
				throw new SessionTransferError(
					"Live children or processes cannot move between runtimes. Wait for them to finish or stop them and retry.",
					"busy",
				);
			if (busy() && !options.stop)
				throw new SessionTransferError(
					"Session is busy. Wait and retry, explicitly request stop, or cancel.",
					"busy",
				);
			if (busy()) {
				this.session.abortCompaction();
				this.session.abortBranchSummary();
				this.session.abortBash();
				this.session.clearQueue();
				await this.session.abort();
			}
			if (busy() || hasAttachedWork())
				throw new SessionTransferError("Work has not stopped yet. Wait and retry.", "busy");
			options.signal?.throwIfAborted();
			this.session.sessionManager.flush();
			await this.teardownCurrent("resume");
		} finally {
			this.transferring = false;
			if (!this.detached) this.session.setTransferring(false);
		}
	}

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		onRuntimeApplied?: AgentSessionRuntimeApplied,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.onRuntimeApplied = onRuntimeApplied;
	}

	private async createOwnedRuntime(
		options: Parameters<CreateAgentSessionRuntimeFactory>[0],
	): Promise<CreateAgentSessionRuntimeResult> {
		try {
			return await this.createRuntime(options);
		} catch (error) {
			options.sessionManager.dispose();
			throw error;
		}
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: (reason: SessionShutdownEvent["reason"]) => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		if (this.detached) return;
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.(reason);
		this.session.dispose();
		this.detached = true;
	}

	private async teardownForReplacement(
		reason: SessionShutdownEvent["reason"],
		sessionManager: SessionManager,
	): Promise<void> {
		try {
			await this.teardownCurrent(reason, sessionManager.getSessionFile());
		} catch (error) {
			sessionManager.dispose();
			throw error;
		}
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this.detached = false;
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.onRuntimeApplied?.(result);
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		if (
			!this.detached &&
			this.session.sessionFile &&
			canonicalSessionPath(sessionPath) === canonicalSessionPath(this.session.sessionFile)
		)
			return { cancelled: false };
		const beforeResult = this.detached ? { cancelled: false } : await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		try {
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			sessionManager.dispose();
			throw error;
		}
		await this.teardownForReplacement("resume", sessionManager);
		this.apply(
			await this.createOwnedRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownForReplacement("new", sessionManager);
		this.apply(
			await this.createOwnedRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownForReplacement("fork", sessionManager);
				this.apply(
					await this.createOwnedRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			const sessionManager = SessionManager.forkBranch(currentSessionFile, targetLeafId, sessionDir);
			const forkedSessionPath = sessionManager.getSessionFile();
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownForReplacement("fork", sessionManager);
			this.apply(
				await this.createOwnedRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager.copyInMemory();
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownForReplacement("fork", sessionManager);
		this.apply(
			await this.createOwnedRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (canonicalSessionPath(destinationPath) !== canonicalSessionPath(resolvedPath)) {
			const ownership = new SessionOwnership(destinationPath);
			try {
				copyFileSync(resolvedPath, destinationPath);
			} finally {
				ownership.release();
			}
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		try {
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			sessionManager.dispose();
			throw error;
		}
		await this.teardownForReplacement("resume", sessionManager);
		this.apply(
			await this.createOwnedRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		await this.teardownCurrent("quit");
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		onRuntimeApplied?: AgentSessionRuntimeApplied;
	},
): Promise<AgentSessionRuntime> {
	let result: CreateAgentSessionRuntimeResult;
	try {
		assertSessionCwdExists(options.sessionManager, options.cwd);
		result = await createRuntime(options);
	} catch (error) {
		options.sessionManager.dispose();
		throw error;
	}
	const runtime = new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
		options.onRuntimeApplied,
	);
	options.onRuntimeApplied?.(result);
	return runtime;
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
