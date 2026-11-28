/**
 * /rollback for interactive mode: restore the files the last turn changed, then fork the
 * conversation to before that turn so the rewind persists. InteractiveMode supplies the session,
 * runtime and editor through RollbackCommandHost.
 */

import * as path from "node:path";
import type { EditorComponent } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	commitRollbackTurn,
	getRollbackRecoveryBlockReason,
	getRollbackTargetUserId,
	isRollbackEnabled,
	migrateRollbackSession,
	peekRollbackTurnsConsumed,
	type RollbackResult,
	rollbackLastTurn,
	rollbackSummary,
} from "../../core/rollback.ts";
import type { SessionManager } from "../../core/session-manager.ts";

/** What /rollback needs from InteractiveMode. InteractiveMode builds one in `createRollbackCommandHost`. */
export interface RollbackCommandHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly runtimeHost: AgentSessionRuntime;
	readonly editor: EditorComponent;
	/** Leaf ids for /redo; a rollback empties it because the forked session has new entry ids. */
	readonly redoStack: string[];
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

// lunr: /rollback — restore last turn's file changes + persistently rewind the conversation.
export async function handleRollbackCommand(host: RollbackCommandHost): Promise<void> {
	if (host.session.isStreaming) {
		host.showWarning("Wait for the current response to finish before running /rollback.");
		return;
	}
	if (!isRollbackEnabled(host.sessionManager.getSessionId())) {
		host.showStatus("Rollback is disabled — enable it in /settings → Rollback");
		return;
	}
	const recoveryBlocked = getRollbackRecoveryBlockReason(host.sessionManager.getSessionId());
	if (recoveryBlocked) {
		host.showWarning(recoveryBlocked);
		return;
	}

	// lunr: how many turns the rollback will consume — the newest non-empty turn
	// plus any empty (chat-only) turns on top of it. The conversation must rewind
	// past the same number of user messages or files and messages desync.
	// Defaults to 1 so /rollback still rewinds one exchange when there's nothing to restore.
	const turnsToConsume = Math.max(1, peekRollbackTurnsConsumed(host.sessionManager.getSessionId()));

	// Find the rewind target (the turnsToConsume-th user message from the end of
	// the current branch) BEFORE mutating anything — forking to it is what makes
	// the rewind persistent.
	const branch = host.sessionManager.getBranch();
	let targetUserId = getRollbackTargetUserId(host.sessionManager.getSessionId());
	if (targetUserId && !branch.some((entry) => entry.id === targetUserId)) {
		host.showWarning("Rollback recovery belongs to another chat branch. Return to that branch to retry.");
		return;
	}
	let userMessagesSeen = 0;
	let fallbackUserId: string | undefined;
	for (let i = branch.length - 1; !targetUserId && i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "user") {
			userMessagesSeen++;
			fallbackUserId = entry.id;
			if (userMessagesSeen >= turnsToConsume) break;
		}
	}
	targetUserId ??= fallbackUserId;
	if (!targetUserId) {
		host.showStatus("Nothing to roll back");
		return;
	}

	let result: RollbackResult;
	try {
		result = rollbackLastTurn(host.sessionManager.getSessionId(), { deferCommit: true, targetUserId });
	} catch (error) {
		host.showError(`Rollback could not prepare recovery: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!result.complete) {
		const failures = result.failed
			.slice(0, 3)
			.map(({ path: file, error }) => `${path.basename(file)}: ${error}`)
			.join("; ");
		host.showWarning(
			`Rollback incomplete. ${result.restored.length} file(s) restored, ${result.deleted.length} deleted, ${result.failed.length} failed. ${failures}. Chat unchanged. /rollback retries this turn's unfinished recovery.`,
		);
		return;
	}

	let chatRewound = false;
	try {
		// Restore first, but keep snapshots and completed-path receipts until
		// the fork succeeds. A veto or exception retries only this chat rewind.
		const oldSid = host.sessionManager.getSessionId();
		const forkResult = await host.runtimeHost.fork(targetUserId, { position: "before" });
		if (forkResult.cancelled) {
			host.showWarning(
				"File recovery complete. Chat rewind cancelled. /rollback retries the same turn without restoring completed files again.",
			);
			return;
		}
		chatRewound = true;
		migrateRollbackSession(oldSid, host.sessionManager.getSessionId());
		if (result.turnIndex !== undefined) commitRollbackTurn(host.sessionManager.getSessionId(), result.turnIndex);
		// /redo cannot cross a fork because the branched session has new entry ids.
		host.redoStack.length = 0;
		if (forkResult.selectedText && !host.editor.getText().trim()) {
			host.editor.setText(forkResult.selectedText);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		host.showError(
			chatRewound
				? `Chat rewound, but finishing rollback failed: ${message}`
				: `File recovery complete; chat rewind failed: ${message}. /rollback retries the same turn.`,
		);
		return;
	}

	// Lists the files bash changed and git state it left; "complete" only when there are none.
	host.showStatus(rollbackSummary(result));
}
