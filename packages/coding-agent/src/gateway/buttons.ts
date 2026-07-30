/**
 * lunR: gateway inline-button picker registry.
 *
 * Provides a platform-agnostic paginated inline-keyboard picker that works
 * over any PlatformAdapter implementing sendButtons/onCallback/answerCallback.
 * A per-paginated-message registry holds the item list and selection handler;
 * a TTL sweeper removes expired entries.
 */

import { randomBytes } from "node:crypto";
import type {
	Button,
	ButtonSpec,
	CallbackEvent,
	MessageEvent,
	PlatformAdapter,
	SendOptions,
	SendResult,
	SessionSource,
} from "./types.ts";

const PICKER_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_PAGE_SIZE = 8;
const BUTTONS_PER_ROW = 2;

export interface PickerItem {
	/** Value that will be passed to the selection handler. */
	id: string;
	/** Label shown on the button. */
	label: string;
}

export interface PickerOptions {
	command: string;
	items: PickerItem[];
	pageSize?: number;
	onSelect(item: PickerItem): Promise<void>;
}

export interface PickerHostContext {
	event: MessageEvent;
	adapter: PlatformAdapter;
	key: string;
}

interface PickerState {
	command: string;
	items: PickerItem[];
	page: number;
	pageSize: number;
	onSelect(item: PickerItem): Promise<void>;
}

interface RegistryEntry {
	state: PickerState;
	source: SessionSource;
	messageId?: string;
	expiresAt: number;
}

const registry = new Map<string, RegistryEntry>();
let sweeper: ReturnType<typeof setInterval> | undefined;

function generatePickerId(): string {
	return randomBytes(4).toString("hex");
}

function makeButtonId(pickerId: string, action: "prev" | "next" | "select", payload?: string): string {
	return `picker:${pickerId}:${action}${payload !== undefined ? `:${payload}` : ""}`;
}

function parseButtonId(buttonId: string): { pickerId: string; action: string; payload?: string } | null {
	const prefix = "picker:";
	if (!buttonId.startsWith(prefix)) return null;
	const rest = buttonId.slice(prefix.length);
	const parts = rest.split(":");
	if (parts.length < 2) return null;
	const pickerId = parts[0];
	const action = parts[1];
	const payload = parts.length > 2 ? parts.slice(2).join(":") : undefined;
	return { pickerId, action, payload };
}

function isSameSource(a: SessionSource, b: SessionSource): boolean {
	return a.platform === b.platform && a.chatId === b.chatId && a.userId === b.userId && a.threadId === b.threadId;
}

function renderPage(pickerId: string, state: PickerState): { text: string; buttons: ButtonSpec } {
	const { command, items, page, pageSize } = state;
	const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
	const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
	const start = clampedPage * pageSize;
	const pageItems = items.slice(start, start + pageSize);

	const rows: ButtonSpec = [];
	for (let i = 0; i < pageItems.length; i += BUTTONS_PER_ROW) {
		const row: Button[] = [];
		for (let j = 0; j < BUTTONS_PER_ROW && i + j < pageItems.length; j++) {
			const index = start + i + j;
			const item = pageItems[i + j];
			row.push({ id: makeButtonId(pickerId, "select", String(index)), label: item.label });
		}
		rows.push(row);
	}

	if (totalPages > 1) {
		const nav: Button[] = [];
		if (clampedPage > 0) nav.push({ id: makeButtonId(pickerId, "prev"), label: "◀ Prev" });
		if (clampedPage < totalPages - 1) nav.push({ id: makeButtonId(pickerId, "next"), label: "Next ▶" });
		if (nav.length > 0) rows.push(nav);
	}

	const text =
		items.length === 0 ? `No ${command} options available.` : `Pick a ${command} (${clampedPage + 1}/${totalPages}):`;
	return { text, buttons: rows };
}

function sendOptionsFor(ctx: PickerHostContext): SendOptions {
	return {
		replyTo: ctx.event.messageId,
		threadId: ctx.event.source.threadId,
	};
}

/**
 * Create and send a paginated inline-button picker for a list of items.
 * The returned message id is stored in the registry so later callbacks can
 * update or clear the keyboard.
 */
export async function createPicker(ctx: PickerHostContext, options: PickerOptions): Promise<SendResult> {
	const pickerId = generatePickerId();
	const state: PickerState = {
		command: options.command,
		items: options.items,
		page: 0,
		pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
		onSelect: options.onSelect,
	};
	const { text, buttons } = renderPage(pickerId, state);
	const result = await ctx.adapter.sendButtons(ctx.event.source.chatId, text, buttons, sendOptionsFor(ctx));
	if (!result.success) return result;

	registry.set(pickerId, {
		state,
		source: ctx.event.source,
		messageId: result.messageId,
		expiresAt: Date.now() + PICKER_TTL_MS,
	});
	return result;
}

/**
 * Dispatch a CallbackEvent to the matching picker entry.
 * Unknown/expired pickers are silently ignored after acknowledging the callback.
 */
export async function handleCallback(event: CallbackEvent, adapter: PlatformAdapter): Promise<void> {
	await adapter.answerCallback(event);
	const parsed = parseButtonId(event.buttonId);
	if (!parsed) return;

	const entry = registry.get(parsed.pickerId);
	if (!entry || !isSameSource(entry.source, event.source)) return;
	if (Date.now() > entry.expiresAt) {
		registry.delete(parsed.pickerId);
		return;
	}

	entry.expiresAt = Date.now() + PICKER_TTL_MS;

	if (parsed.action === "prev" || parsed.action === "next") {
		const totalPages = Math.ceil(entry.state.items.length / entry.state.pageSize);
		const delta = parsed.action === "prev" ? -1 : 1;
		entry.state.page = Math.max(0, Math.min(entry.state.page + delta, totalPages - 1));
		const { text, buttons } = renderPage(parsed.pickerId, entry.state);
		if (entry.messageId) {
			await adapter.editMessage(event.source.chatId, entry.messageId, text, {
				buttons,
				threadId: event.source.threadId,
			});
		}
		return;
	}

	if (parsed.action === "select") {
		const index = Number.parseInt(parsed.payload ?? "", 10);
		const item = entry.state.items[index];
		if (!item) return;

		if (entry.messageId) {
			await adapter.editMessage(event.source.chatId, entry.messageId, `Selected: ${item.label}`, {
				buttons: [],
				threadId: event.source.threadId,
			});
		}
		registry.delete(parsed.pickerId);
		await entry.state.onSelect(item);
	}
}

/** Start the periodic TTL sweeper. Idempotent. */
export function startButtonSweeper(): void {
	if (sweeper) return;
	sweeper = setInterval(() => {
		const now = Date.now();
		for (const [id, entry] of registry) {
			if (now > entry.expiresAt) registry.delete(id);
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

/** Test hook: expose a snapshot of active picker ids. */
export function activePickerIds(): string[] {
	return [...registry.keys()];
}
