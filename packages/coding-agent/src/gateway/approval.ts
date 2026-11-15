/**
 * Gateway approvals for large subagent launches, auto review and plans.
 * A missing chat context rejects large launches; plans pass through.
 * An approved plan restores the mode the chat used before /plan; an unanswered
 * plan prompt leaves the model waiting for the user instead of reading as a decline.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	NO_HANDLER_REASON,
	type PermissionMode,
	PLAN_APPROVAL_TIMEOUT_REASON,
	registerApprovalHandler,
	restorePermissionModeAfterPlan,
	setPermissionMode,
} from "../core/permissions.ts";
import type { BridgeSession } from "./agent-bridge.ts";
import { isAuthorized } from "./authz.ts";
import { loadGatewayConfig } from "./config.ts";
import { conversationBinding } from "./conversations.ts";
import { createPairingStore } from "./pairing.ts";
import { queueGatewayText } from "./presenter.ts";
import { getSession } from "./store.ts";
import type { ButtonSpec, CallbackEvent, PlatformAdapter, SessionSource } from "./types.ts";

const CALLBACK_PREFIX = "ap:";
const ID_LENGTH = 8;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface ApprovalContext {
	key: string;
	adapter: PlatformAdapter;
	source: SessionSource;
	timeoutMs?: number;
	/** Live session for the chat, so an approved plan restores its mode through the session setter. */
	session?: () => BridgeSession | undefined;
}

interface PendingApproval {
	key?: string;
	source: SessionSource;
	plan: boolean;
	session?: () => BridgeSession | undefined;
	resolve: (value: ApprovalResponse) => void;
	reject: (reason?: unknown) => void;
	timeout: ReturnType<typeof setTimeout>;
	messageId?: string;
	adapter: PlatformAdapter;
	chatId: string;
	threadId?: string;
	userId: string;
}

const approvalContext = new AsyncLocalStorage<ApprovalContext>();
const pending = new Map<string, PendingApproval>();
/** Mode each session used before the chat switched it to read-only, keyed by session id. */
const modesBeforePlan = new Map<string, PermissionMode>();

/** Record the mode a chat leaves when it switches to read-only, so plan approval can return to it. */
export function rememberModeBeforePlan(sessionId: string, previous: PermissionMode, next: PermissionMode): void {
	if (next === "read-only" && previous !== "read-only") modesBeforePlan.set(sessionId, previous);
}

function generateId(): string {
	let id = "";
	const bytes = randomBytes(ID_LENGTH);
	for (let i = 0; i < ID_LENGTH; i++) {
		id += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	}
	return id;
}

function makeCallbackData(id: string, action: ApprovalResponse | "cancel"): string {
	return `${CALLBACK_PREFIX}${id}:${action}`;
}

function parseCallbackData(data: string): { id: string; action: ApprovalResponse | "cancel" } | null {
	if (!data.startsWith(CALLBACK_PREFIX)) return null;
	const rest = data.slice(CALLBACK_PREFIX.length);
	const colon = rest.indexOf(":");
	if (colon === -1) return null;
	const id = rest.slice(0, colon);
	const action = rest.slice(colon + 1);
	if (action === "once" || action === "session" || action === "reject" || action === "cancel") {
		return { id, action };
	}
	return null;
}

/** Run code with the gateway approval context available to tool-call gates. */
export function runWithApprovalContext<T>(ctx: ApprovalContext, fn: () => Promise<T>): Promise<T> {
	return approvalContext.run(ctx, fn);
}

/**
 * Build the buttons message text. Detail that would push it past the adapter limit
 * goes first through the chunked outbox, and the buttons message points back to it.
 */
async function approvalTitle(
	adapter: PlatformAdapter,
	source: SessionSource,
	heading: string,
	detail: string,
	key?: string,
): Promise<string> {
	const full = `${heading}\n${detail}`;
	if (full.length <= adapter.maxMessageLength) return full;
	if (key) {
		await queueGatewayText(key, source, adapter, detail, { kind: "notice" });
		return `${heading}\n(Details in the messages above.)`.slice(0, adapter.maxMessageLength);
	}
	return `${full.slice(0, adapter.maxMessageLength - 1)}…`;
}

async function createApprovalPrompt(
	adapter: PlatformAdapter,
	source: SessionSource,
	req: ApprovalRequest,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	key?: string,
	session?: () => BridgeSession | undefined,
): Promise<ApprovalResponse> {
	const id = generateId();
	// Large child launches get a dedicated title; inline buttons cannot capture feedback.
	const heading =
		req.kind === "large-subagent-launch"
			? "Approve large subagent launch?"
			: req.kind === "auto-review"
				? `Auto review stopped a ${req.toolName} call. Run it anyway?`
				: req.kind === "plan"
					? "Approve this plan?"
					: `Approve ${req.toolName}?`;
	// Auto-review and plan decisions cover one action, so they have no session-wide approval.
	const rows: ButtonSpec[][] =
		req.kind === "auto-review"
			? [
					[
						{ label: "✓ Run it once", data: makeCallbackData(id, "once") },
						{ label: "✗ Keep it blocked", data: makeCallbackData(id, "reject") },
					],
				]
			: req.kind === "plan"
				? [
						[
							{ label: "✓ Approve", data: makeCallbackData(id, "once") },
							{ label: "✗ Reject", data: makeCallbackData(id, "reject") },
						],
					]
				: [
						[
							{ label: "✓ Approve once", data: makeCallbackData(id, "once") },
							{ label: "✓ Approve session", data: makeCallbackData(id, "session") },
						],
						[{ label: "✗ Reject", data: makeCallbackData(id, "reject") }],
					];
	const title = await approvalTitle(adapter, source, heading, req.detail, key);

	return new Promise<ApprovalResponse>((resolve, reject) => {
		let messageId: string | undefined;
		const timeout = setTimeout(() => {
			pending.delete(id);
			// An unanswered plan is not a decline: present_plan tells the model to wait for the user.
			reject(new Error(req.kind === "plan" ? PLAN_APPROVAL_TIMEOUT_REASON : "Approval request timed out"));
			if (messageId) {
				const expired =
					req.kind === "plan"
						? "⏱ Plan approval expired. Reply here to approve or change the plan."
						: "⏱ Approval expired.";
				void adapter.editMessage(source.chatId, messageId, expired, []).catch(() => {});
			}
		}, timeoutMs);

		const entry: PendingApproval = {
			key,
			source,
			plan: req.kind === "plan",
			session,
			resolve,
			reject,
			timeout,
			adapter,
			chatId: source.chatId,
			threadId: source.threadId,
			userId: source.userId,
		};
		pending.set(id, entry);
		void (async () => {
			try {
				const result = await adapter.sendButtons(source.chatId, title, rows, { threadId: source.threadId });
				if (!result.success || !result.messageId) throw new Error(result.error ?? "Failed to send approval prompt");
				messageId = result.messageId;
				if (pending.get(id) !== entry) {
					await adapter
						.editMessage(source.chatId, messageId, "Approval cancelled or expired.", [])
						.catch(() => {});
					return;
				}
				entry.messageId = messageId;
			} catch (err) {
				clearTimeout(timeout);
				pending.delete(id);
				reject(err);
			}
		})();
	});
}

/** Approval handler passed to core permissions. */
export async function createGatewayApprovalRequest(req: ApprovalRequest): Promise<ApprovalResponse> {
	const ctx = approvalContext.getStore();
	if (!ctx) {
		throw new Error(NO_HANDLER_REASON);
	}
	return createApprovalPrompt(ctx.adapter, ctx.source, req, ctx.timeoutMs, ctx.key, ctx.session);
}

/** Register the gateway approval handler with the core permission gate. */
export function registerGatewayApprovalHandler(): void {
	registerApprovalHandler(createGatewayApprovalRequest);
}

/**
 * Dispatch a callback event to an outstanding approval prompt.
 * Returns true when the data matched the approval prefix (whether or not a
 * pending prompt existed).
 */
export async function handleApprovalCallback(event: CallbackEvent, adapter?: PlatformAdapter): Promise<boolean> {
	const parsed = parseCallbackData(event.data);
	if (!parsed) return false;

	const entry = pending.get(parsed.id);
	if (!entry) {
		// Best-effort answer for stale callbacks.
		await adapter?.answerCallback(event.id, "Approval expired.").catch(() => {});
		return true;
	}

	if (
		event.userId !== entry.userId ||
		event.chatId !== entry.chatId ||
		event.threadId !== entry.threadId ||
		(adapter && adapter.platform !== entry.adapter.platform)
	) {
		await entry.adapter.answerCallback(event.id, "⛔ Not your approval.").catch(() => {});
		return true;
	}

	clearTimeout(entry.timeout);
	pending.delete(parsed.id);

	const response: ApprovalResponse =
		parsed.action === "reject" || parsed.action === "cancel" ? "reject" : parsed.action;
	const binding = entry.key ? conversationBinding(entry.key) : undefined;
	if (binding?.owner && binding.owner !== event.userId) {
		entry.resolve("reject");
		await entry.adapter.answerCallback(event.id, "This session belongs to a different user.").catch(() => {});
		return true;
	}
	if (binding && !isAuthorized(entry.source, loadGatewayConfig(), createPairingStore())) {
		entry.resolve("reject");
		return true;
	}
	if (entry.plan && response !== "reject") restoreModeAfterPlan(entry);
	entry.resolve(response);

	const label =
		parsed.action === "reject" || parsed.action === "cancel"
			? "Rejected."
			: entry.plan
				? "Approved."
				: `Approved (${parsed.action}).`;
	await entry.adapter.editMessage(entry.chatId, entry.messageId ?? "", label, []).catch(() => {});
	await entry.adapter.answerCallback(event.id).catch(() => {});
	return true;
}

/**
 * Leave read-only after an approved plan, as the TUI does: return to the mode used before
 * /plan (or the saved default), never read-only, and auto only while its reviewer is ready.
 * The live session setter also saves the mode so a reopened chat keeps it.
 */
function restoreModeAfterPlan(entry: PendingApproval): void {
	const session = entry.session?.();
	const sessionId =
		session?.sessionManager?.getSessionId() ?? (entry.key ? getSession(entry.key)?.sessionId : undefined);
	if (!sessionId) return;
	const previous = modesBeforePlan.get(sessionId);
	modesBeforePlan.delete(sessionId);
	let target = restorePermissionModeAfterPlan(
		previous,
		session?.settingsManager?.getDefaultPermissionMode() ?? "yolo",
	);
	if (target === "read-only") target = "yolo";
	if (target === "auto" && session?.resolveAutoReviewer && session.resolveAutoReviewer().kind !== "ready")
		target = "yolo";
	if (session?.setPermissionMode) session.setPermissionMode(target);
	else setPermissionMode(target, sessionId);
}

/** Test hook: clear all pending approvals and stop their timeouts. */
export function cancelGatewayApprovals(key: string): void {
	for (const [id, entry] of pending) {
		if (entry.key !== key) continue;
		clearTimeout(entry.timeout);
		pending.delete(id);
		entry.resolve("reject");
		if (entry.messageId)
			void entry.adapter.editMessage(entry.chatId, entry.messageId, "Approval cancelled.", []).catch(() => {});
	}
}

export function resetApprovalRegistry(): void {
	for (const entry of pending.values()) {
		clearTimeout(entry.timeout);
		try {
			entry.reject(new Error("Approval registry reset"));
		} catch {
			// ignore settled promise
		}
	}
	pending.clear();
}

/** Test hook: number of outstanding approval prompts. */
export function activeApprovalCount(): number {
	return pending.size;
}
