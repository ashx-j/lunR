/**
 * lunR: gateway approval prompt for manual permission mode.
 *
 * The gateway runs headless sessions. When a mutating tool call arrives in
 * manual mode, this module posts an inline-button approve/reject prompt to
 * the originating chat and awaits the callback. If no chat context is present
 * the request is rejected (fail-closed).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	NO_HANDLER_REASON,
	registerApprovalHandler,
} from "../core/permissions.ts";
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
}

interface PendingApproval {
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

async function createApprovalPrompt(
	adapter: PlatformAdapter,
	source: SessionSource,
	req: ApprovalRequest,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ApprovalResponse> {
	const id = generateId();
	// lunr: auto-activated agent swarms get the "agent swarm" title; buttons stay
	// once/session/reject (inline buttons cannot capture reject feedback).
	const title =
		req.kind === "swarm" ? `▶ Approve agent swarm?\n${req.detail}` : `Approve ${req.toolName}?\n${req.detail}`;
	const rows: ButtonSpec[][] = [
		[
			{ label: "✓ Approve once", data: makeCallbackData(id, "once") },
			{ label: "✓ Approve session", data: makeCallbackData(id, "session") },
		],
		[{ label: "✗ Reject", data: makeCallbackData(id, "reject") }],
	];

	return new Promise<ApprovalResponse>((resolve, reject) => {
		let messageId: string | undefined;
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error("Approval request timed out"));
			if (messageId) {
				void adapter.editMessage(source.chatId, messageId, "⏱ Approval expired.", []).catch(() => {});
			}
		}, timeoutMs);

		void (async () => {
			try {
				const result = await adapter.sendButtons(source.chatId, title, rows, { threadId: source.threadId });
				if (!result.success || !result.messageId) {
					clearTimeout(timeout);
					reject(new Error(result.error ?? "Failed to send approval prompt"));
					return;
				}
				messageId = result.messageId;
				pending.set(id, {
					resolve,
					reject,
					timeout,
					messageId,
					adapter,
					chatId: source.chatId,
					threadId: source.threadId,
					userId: source.userId,
				});
			} catch (err) {
				clearTimeout(timeout);
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
	return createApprovalPrompt(ctx.adapter, ctx.source, req, ctx.timeoutMs);
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

	if (event.userId !== entry.userId) {
		await entry.adapter.answerCallback(event.id, "⛔ Not your approval.").catch(() => {});
		return true;
	}

	clearTimeout(entry.timeout);
	pending.delete(parsed.id);

	const response: ApprovalResponse =
		parsed.action === "reject" || parsed.action === "cancel" ? "reject" : parsed.action;
	entry.resolve(response);

	const label =
		parsed.action === "reject" || parsed.action === "cancel" ? "Rejected." : `Approved (${parsed.action}).`;
	await entry.adapter.editMessage(entry.chatId, entry.messageId ?? "", label, []).catch(() => {});
	await entry.adapter.answerCallback(event.id).catch(() => {});
	return true;
}

/** Test hook: clear all pending approvals and stop their timeouts. */
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
