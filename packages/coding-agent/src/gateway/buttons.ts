/**
 * lunR: gateway inline-button picker registry.
 *
 * Single registry for all interactive prompts (model/thinking/sessions pickers
 * now; approvals later). Callback payloads stay tiny so they fit Telegram's
 * 64-byte callback_data limit; all picker state lives server-side in this module.
 */

import { randomBytes } from "node:crypto";
import { isAuthorized } from "./authz.ts";
import type { GatewayConfig } from "./config.ts";
import type { PairingStore } from "./pairing.ts";
import type { BridgeLike } from "./router.ts";
import type { ButtonSpec, CallbackEvent, PlatformAdapter, SendOptions, SendResult, SessionSource } from "./types.ts";

const PICKER_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_PER_PAGE = 8;
const BUTTONS_PER_ROW = 2;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CALLBACK_PREFIX = "cp:";

export interface PickerItem {
	label: string;
	value: string;
}

export type PickerResolveResult =
	| { done: true; text: string }
	| { done: false; items: PickerItem[]; title: string; breadcrumbs?: string };

export interface PickerSpec {
	kind: "model" | "thinking" | "sessions";
	sessionKey: string;
	invokerId: string;
	items: PickerItem[];
	perPage?: number;
	title: string;
	breadcrumbs?: string;
	resolve(item: PickerItem): Promise<PickerResolveResult>;
}

interface PendingPicker extends PickerSpec {
	id: string;
	chatId: string;
	messageId: string;
	source: SessionSource;
	adapter: PlatformAdapter;
	page: number;
	perPage: number;
	createdAt: number;
}

export interface ButtonDeps {
	adapters: Map<string, PlatformAdapter>;
	cfg: GatewayConfig;
	pairing: PairingStore;
	bridge: BridgeLike;
}

const registry = new Map<string, PendingPicker>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function generatePickerId(): string {
	let id = "";
	const bytes = randomBytes(CODE_LENGTH);
	for (let i = 0; i < CODE_LENGTH; i++) {
		id += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	}
	return id;
}

function makeCallbackData(id: string, action: "select" | "page" | "cancel" | "noop", payload?: string): string {
	if (action === "noop") return `${CALLBACK_PREFIX}${id}:`;
	if (action === "cancel") return `${CALLBACK_PREFIX}${id}:x`;
	if (action === "page") return `${CALLBACK_PREFIX}${id}:p${payload ?? "0"}`;
	return `${CALLBACK_PREFIX}${id}:${payload ?? ""}`;
}

function parseCallbackData(
	data: string,
): { id: string; action: "select" | "page" | "cancel" | "noop"; payload?: string } | null {
	if (!data.startsWith(CALLBACK_PREFIX)) return null;
	const rest = data.slice(CALLBACK_PREFIX.length);
	const colon = rest.indexOf(":");
	if (colon === -1) return null;
	const id = rest.slice(0, colon);
	const tail = rest.slice(colon + 1);
	if (tail === "") return { id, action: "noop" };
	if (tail === "x") return { id, action: "cancel" };
	if (tail.startsWith("p")) return { id, action: "page", payload: tail.slice(1) };
	return { id, action: "select", payload: tail };
}

function isSameChat(a: SessionSource, b: SessionSource): boolean {
	return a.platform === b.platform && a.chatId === b.chatId && a.threadId === b.threadId;
}

function sourceForAuth(picker: PendingPicker, cb: CallbackEvent): SessionSource {
	return {
		platform: picker.source.platform,
		chatId: cb.chatId,
		chatType: picker.source.chatType,
		userId: cb.userId,
		userName: cb.userName,
		threadId: cb.threadId,
		// Do NOT inherit the original invoker's role authorization.
		roleAuthorized: undefined,
	};
}

function renderPage(picker: PendingPicker): { text: string; buttons: ButtonSpec[][] } {
	const { id, title, breadcrumbs, items, page, perPage } = picker;
	const totalPages = Math.max(1, Math.ceil(items.length / perPage));
	const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
	const start = clampedPage * perPage;
	const pageItems = items.slice(start, start + perPage);

	const rows: ButtonSpec[][] = [];
	for (let i = 0; i < pageItems.length; i += BUTTONS_PER_ROW) {
		const row: ButtonSpec[] = [];
		for (let j = 0; j < BUTTONS_PER_ROW && i + j < pageItems.length; j++) {
			const index = start + i + j;
			row.push({ label: pageItems[i + j].label, data: makeCallbackData(id, "select", String(index)) });
		}
		rows.push(row);
	}

	if (totalPages > 1) {
		const nav: ButtonSpec[] = [];
		if (clampedPage > 0) {
			nav.push({ label: "◀ Prev", data: makeCallbackData(id, "page", String(clampedPage - 1)) });
		}
		nav.push({ label: `${clampedPage + 1}/${totalPages}`, data: makeCallbackData(id, "noop") });
		if (clampedPage < totalPages - 1) {
			nav.push({ label: "Next ▶", data: makeCallbackData(id, "page", String(clampedPage + 1)) });
		}
		rows.push(nav);
	}

	rows.push([{ label: "✗ Cancel", data: makeCallbackData(id, "cancel") }]);

	const header = breadcrumbs ? `${title} · ${breadcrumbs}` : title;
	const text =
		items.length === 0 ? `${header}\n\nNo options available.` : `${header} (${clampedPage + 1}/${totalPages}):`;
	return { text, buttons: rows };
}

/**
 * Create and send a paginated inline-button picker. On send failure the caller
 * should fall back to a text-based list.
 */
export async function createPicker(
	adapter: PlatformAdapter,
	source: SessionSource,
	spec: PickerSpec,
	opts?: SendOptions,
): Promise<SendResult> {
	const id = generatePickerId();
	const pending: PendingPicker = {
		...spec,
		id,
		chatId: source.chatId,
		source,
		adapter,
		messageId: "",
		page: 0,
		perPage: spec.perPage ?? DEFAULT_PER_PAGE,
		createdAt: Date.now(),
	};
	const { text, buttons } = renderPage(pending);
	const result = await adapter.sendButtons(source.chatId, text, buttons, opts);
	if (!result.success) return result;
	if (result.messageId) {
		pending.messageId = result.messageId;
		registry.set(id, pending);
	}
	return result;
}

async function answerExpired(adapter: PlatformAdapter, cb: CallbackEvent): Promise<void> {
	await adapter.answerCallback(cb.id, "Picker expired — run the command again.").catch(() => {});
}

async function answerUnauthorized(adapter: PlatformAdapter, cb: CallbackEvent): Promise<void> {
	await adapter.answerCallback(cb.id, "⛔ Not authorized.").catch(() => {});
}

async function answerNotYourPicker(adapter: PlatformAdapter, cb: CallbackEvent): Promise<void> {
	await adapter.answerCallback(cb.id, "⛔ Not your picker.").catch(() => {});
}

/** Dispatch a CallbackEvent to the matching picker entry. */
export async function handleCallback(
	cb: CallbackEvent,
	deps: ButtonDeps & { adapter: PlatformAdapter },
): Promise<void> {
	const { adapter, cfg, pairing } = deps;
	const parsed = parseCallbackData(cb.data);
	if (!parsed) return;

	const picker = registry.get(parsed.id);
	if (!picker) {
		await answerExpired(adapter, cb);
		return;
	}

	if (Date.now() > picker.createdAt + PICKER_TTL_MS) {
		registry.delete(parsed.id);
		try {
			await picker.adapter.editMessage(picker.chatId, picker.messageId, "⏱ Expired — run the command again.", []);
		} catch {
			// best-effort expiry message
		}
		await answerExpired(adapter, cb);
		return;
	}

	if (!isSameChat(picker.source, sourceForAuth(picker, cb))) {
		await answerExpired(adapter, cb);
		return;
	}

	if (cb.userId !== picker.invokerId) {
		await answerNotYourPicker(adapter, cb);
		return;
	}

	if (!isAuthorized(sourceForAuth(picker, cb), cfg, pairing)) {
		await answerUnauthorized(adapter, cb);
		return;
	}

	if (parsed.action === "cancel") {
		registry.delete(parsed.id);
		try {
			await picker.adapter.editMessage(picker.chatId, picker.messageId, "Cancelled.", []);
		} catch {}
		await adapter.answerCallback(cb.id).catch(() => {});
		return;
	}

	if (parsed.action === "noop") {
		await adapter.answerCallback(cb.id).catch(() => {});
		return;
	}

	if (parsed.action === "page") {
		const page = Number.parseInt(parsed.payload ?? "0", 10);
		const totalPages = Math.max(1, Math.ceil(picker.items.length / picker.perPage));
		picker.page = Math.max(0, Math.min(page, totalPages - 1));
		const { text, buttons } = renderPage(picker);
		try {
			await picker.adapter.editMessage(picker.chatId, picker.messageId, text, buttons);
		} catch {}
		await adapter.answerCallback(cb.id).catch(() => {});
		return;
	}

	// select
	const index = Number.parseInt(parsed.payload ?? "", 10);
	const item = picker.items[index];
	if (!item) {
		await adapter.answerCallback(cb.id, "Invalid selection.").catch(() => {});
		return;
	}

	try {
		const result = await picker.resolve(item);
		if (!result.done) {
			picker.items = result.items;
			picker.title = result.title;
			picker.breadcrumbs = result.breadcrumbs;
			picker.page = 0;
			const { text, buttons } = renderPage(picker);
			try {
				await picker.adapter.editMessage(picker.chatId, picker.messageId, text, buttons);
			} catch {}
			await adapter.answerCallback(cb.id).catch(() => {});
			return;
		}
		registry.delete(parsed.id);
		try {
			await picker.adapter.editMessage(picker.chatId, picker.messageId, result.text, []);
		} catch {}
		await adapter.answerCallback(cb.id).catch(() => {});
	} catch (err) {
		registry.delete(parsed.id);
		const message = err instanceof Error ? err.message : String(err);
		try {
			await picker.adapter.editMessage(picker.chatId, picker.messageId, `⚠ ${message}`, []);
		} catch {}
		await adapter.answerCallback(cb.id).catch(() => {});
	}
}

/** Start the periodic TTL sweeper. Idempotent. */
export function startButtonSweeper(): void {
	if (sweeper) return;
	sweeper = setInterval(() => {
		const cutoff = Date.now() - PICKER_TTL_MS;
		for (const [id, entry] of registry) {
			if (entry.createdAt > cutoff) continue;
			registry.delete(id);
			try {
				void entry.adapter.editMessage(entry.chatId, entry.messageId, "⏱ Expired — run the command again.", []);
			} catch {
				// best-effort expiry edit
			}
		}
	}, SWEEP_INTERVAL_MS);
	sweeper.unref?.();
}

/** Stop the TTL sweeper. */
export function stopButtonSweeper(): void {
	if (sweeper) {
		clearInterval(sweeper);
		sweeper = undefined;
	}
}

/** Test hook: reset the registry and stop the sweeper. */
export function resetButtonRegistry(): void {
	registry.clear();
	stopButtonSweeper();
}

/** Test hook: expose active picker ids. */
export function activePickerIds(): string[] {
	return [...registry.keys()];
}
