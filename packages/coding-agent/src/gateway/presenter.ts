import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { noOpUIContext } from "../core/extensions/runner.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../core/extensions/types.ts";
import { runWithApprovalContext } from "./approval.ts";
import { isAuthorized } from "./authz.ts";
import { createPicker, gatewayPickerGeneration, invalidateGatewayPickers } from "./buttons.ts";
import { type GatewayConfig, gatewayConfigPath, loadGatewayConfig } from "./config.ts";
import { conversationBinding } from "./conversations.ts";
import { createPairingStore, type PairingStore } from "./pairing.ts";
import { atomicJson } from "./service.ts";
import { splitMessage } from "./text.ts";
import type { MessageEvent, PlatformAdapter, SendOptions } from "./types.ts";

const epochs = new Map<string, number>();
const sessionIdentities = new Map<string, object>();

function sessionIdentity(key: string): object {
	let identity = sessionIdentities.get(key);
	if (!identity) {
		identity = {};
		sessionIdentities.set(key, identity);
	}
	return identity;
}

/** Retire session UI independently of cancelling its current dialogs. Roll back a failed replacement. */
export function invalidateGatewaySession(key: string): () => void {
	const previous = sessionIdentity(key);
	const next = {};
	sessionIdentities.set(key, next);
	invalidateGatewayDialogs(key);
	return () => {
		if (sessionIdentities.get(key) === next) {
			invalidateGatewayDialogs(key);
			sessionIdentities.set(key, previous);
		}
	};
}
const inputs = new Map<string, { userId: string; resolve: (value: string | undefined) => void }>();
const dialogs = new Map<string, Set<() => void>>();
let adapters = new Map<string, PlatformAdapter>();
const deliveryConfigs = new Map<string, GatewayConfig>();
const roleGrants = new Map<string, { userId: string; chatId: string; threadId?: string }>();
let timer: ReturnType<typeof setInterval> | undefined;
const activeDeliveries = new Map<string, Promise<void>>();
interface Outbound {
	id: string;
	key: string;
	epoch: number;
	text: string;
	source?: MessageEvent["source"];
	replyTo?: string;
	kind?: "result" | "notice";
	attempts?: number;
	nextAttempt?: number;
	failed?: boolean;
	batchId?: string;
}
const MAX_ATTEMPTS = 5;
const path = () => join(getAgentDir(), "gateway-outbox.json");
let outbox: Outbound[] = [];

function sourceWithCurrentRole(key: string, source: MessageEvent["source"]): MessageEvent["source"] {
	const grant = roleGrants.get(key);
	return {
		...source,
		roleAuthorized:
			grant?.userId === source.userId && grant.chatId === source.chatId && grant.threadId === source.threadId,
	};
}

export function rememberGatewayRole(key: string, source: MessageEvent["source"]): void {
	if (source.roleAuthorized === true)
		roleGrants.set(key, { userId: source.userId, chatId: source.chatId, threadId: source.threadId });
	else roleGrants.delete(key);
}

/** Fresh delivery authorization shared by previews, final edits and durable retries. */
export function canDeliverGatewayText(
	key: string,
	source: MessageEvent["source"],
	fallbackConfig?: GatewayConfig,
	pairing: PairingStore = createPairingStore(),
): boolean {
	const binding = conversationBinding(key);
	const cfg = existsSync(gatewayConfigPath()) ? loadGatewayConfig() : (fallbackConfig ?? loadGatewayConfig());
	return (
		(!binding ||
			(binding.source.platform === source.platform &&
				binding.source.chatId === source.chatId &&
				binding.source.userId === source.userId &&
				binding.source.threadId === source.threadId &&
				(!binding.owner || binding.owner === source.userId))) &&
		isAuthorized(sourceWithCurrentRole(key, source), cfg, pairing)
	);
}

function canDeliver(key: string): boolean {
	const binding = conversationBinding(key);
	return !!binding && canDeliverGatewayText(key, binding.source);
}

export function gatewayDestination(key: string): { adapter: PlatformAdapter; source: MessageEvent["source"] } {
	const binding = conversationBinding(key);
	const adapter = binding && adapters.get(binding.source.platform);
	if (!binding || !adapter || !canDeliver(key))
		throw new Error("This chat is no longer authorized or its platform is disconnected.");
	return { adapter, source: binding.source };
}

export function withGatewayPresentation<T>(key: string, run: () => Promise<T>): Promise<T> {
	const { adapter, source } = gatewayDestination(key);
	return runWithApprovalContext({ adapter, source, key }, run);
}

export function startGatewayPresenter(connected: Map<string, PlatformAdapter>): void {
	adapters = connected;
	if (existsSync(path())) {
		try {
			const raw: unknown = JSON.parse(readFileSync(path(), "utf8"));
			if (
				!Array.isArray(raw) ||
				!raw.every(
					(item) =>
						item && typeof item.id === "string" && typeof item.key === "string" && typeof item.text === "string",
				)
			)
				throw new Error("Invalid outbox");
			outbox = raw as Outbound[];
		} catch {
			throw new Error("Gateway outbox is invalid. Restore it before starting.");
		}
	} else outbox = [];
	for (const item of outbox) {
		if (item.kind === "notice") epochs.set(item.key, Math.max(epochs.get(item.key) ?? 0, item.epoch ?? 0));
	}
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		void flushOutbox().catch((error) => console.error("[gateway] outbox flush failed:", error));
	}, 3000);
	timer.unref();
	void flushOutbox().catch((error) => console.error("[gateway] outbox flush failed:", error));
}

export function stopGatewayPresenter(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
	for (const key of new Set([...sessionIdentities.keys(), ...dialogs.keys()])) invalidateGatewaySession(key);
	adapters = new Map();
	deliveryConfigs.clear();
	roleGrants.clear();
}

export function gatewayEpoch(key: string): number {
	return epochs.get(key) ?? 0;
}

export async function sendGatewayNotice(
	key: string,
	text: string,
	kind: "notice" | "result" = "notice",
	epoch = gatewayEpoch(key),
): Promise<void> {
	const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
	if (!clean || !canDeliver(key)) return;
	const { adapter, source } = gatewayDestination(key);
	await queueGatewayText(key, source, adapter, clean, { kind, epoch });
}

export async function queueGatewayText(
	key: string,
	source: MessageEvent["source"],
	adapter: PlatformAdapter,
	text: string,
	options: { kind: "result" | "notice"; replyTo?: string; cfg?: GatewayConfig; chunks?: string[]; epoch?: number },
): Promise<void> {
	if (!text || (options.kind === "notice" && options.epoch !== undefined && options.epoch !== gatewayEpoch(key)))
		return;
	adapters.set(source.platform, adapter);
	if (options.cfg) deliveryConfigs.set(key, options.cfg);
	const chunks = options.chunks ?? splitMessage(text, adapter.maxMessageLength);
	const batchId = randomUUID();
	for (const [index, chunk] of chunks.entries())
		outbox.push({
			id: randomUUID(),
			batchId,
			key,
			source: { ...source, roleAuthorized: undefined },
			epoch: options.epoch ?? gatewayEpoch(key),
			text: chunk,
			kind: options.kind,
			replyTo: index === 0 ? options.replyTo : undefined,
		});
	atomicJson(path(), outbox);
	if (activeDeliveries.has(key)) await activeDeliveries.get(key);
	await flushKey(key);
}

export function flushGatewayOutbox(): Promise<void> {
	return flushOutbox();
}

function flushOutbox(): Promise<void> {
	return Promise.all([...new Set(outbox.map((item) => item.key))].map(flushKey)).then(() => {});
}

function flushKey(key: string): Promise<void> {
	const current = activeDeliveries.get(key);
	if (current) return current;
	const running = drainKey(key).finally(() => {
		activeDeliveries.delete(key);
	});
	activeDeliveries.set(key, running);
	return running;
}

async function drainKey(key: string): Promise<void> {
	const failedBatches = new Set(outbox.filter((item) => item.failed && item.batchId).map((item) => item.batchId));
	for (const item of [...outbox].filter((item) => item.key === key)) {
		if (item.failed || (item.batchId && failedBatches.has(item.batchId))) continue;
		if (item.kind === "notice" && item.epoch !== (epochs.get(item.key) ?? 0)) {
			outbox = outbox.filter((v) => v.id !== item.id);
			atomicJson(path(), outbox);
			continue;
		}
		const binding = conversationBinding(item.key);
		const source = item.source ?? binding?.source;
		if (!source) break;
		if (!canDeliverGatewayText(key, source, deliveryConfigs.get(key))) {
			outbox = outbox.filter((v) => v.id !== item.id);
			atomicJson(path(), outbox);
			continue;
		}
		const adapter = adapters.get(source.platform);
		if (!adapter || (item.nextAttempt ?? 0) > Date.now()) break;
		const opts: SendOptions = { threadId: source.threadId, replyTo: item.replyTo };
		const result = await adapter
			.send(source.chatId, item.text, opts)
			.catch((error: unknown) => ({ success: false as const, error: String(error), retryable: true }));
		if (result.success) {
			outbox = outbox.filter((v) => v.id !== item.id);
			atomicJson(path(), outbox);
		} else {
			item.attempts = (item.attempts ?? 0) + 1;
			item.failed = result.retryable === false || item.attempts >= MAX_ATTEMPTS;
			item.nextAttempt = Date.now() + Math.min(60_000, 3000 * 2 ** (item.attempts - 1));
			if (item.failed && item.batchId) {
				failedBatches.add(item.batchId);
				for (const pending of outbox) if (pending.batchId === item.batchId) pending.failed = true;
			}
			atomicJson(path(), outbox);
			console.error(
				`[gateway] delivery ${item.failed ? "failed permanently" : "retry scheduled"} for ${source.platform}: ${result.error ?? "unknown error"}`,
			);
			break;
		}
	}
}

export function invalidateGatewayDialogs(key: string): void {
	invalidateGatewayPickers(key);
	epochs.set(key, (epochs.get(key) ?? 0) + 1);
	const remaining = outbox.filter((item) => item.key !== key || item.kind !== "notice");
	if (remaining.length !== outbox.length) {
		outbox = remaining;
		atomicJson(path(), outbox);
	}
	for (const cancel of dialogs.get(key) ?? []) cancel();
	dialogs.delete(key);
	inputs.delete(key);
}

export function acceptGatewayInput(key: string, event: MessageEvent): boolean {
	const input = inputs.get(key);
	if (!input || input.userId !== event.source.userId || !canDeliver(key)) return false;
	if (event.text.startsWith("/") && event.text !== "/cancel") return false;
	input.resolve(event.text === "/cancel" ? undefined : event.text);
	return true;
}

interface GatewayDialogRequest {
	generation: number;
	source: MessageEvent["source"];
}

function dialog(
	key: string,
	opts: ExtensionUIDialogOptions | undefined,
	show: (done: (value: string | undefined) => void, valid: () => boolean) => Promise<void>,
	request?: GatewayDialogRequest,
): Promise<string | undefined> {
	if (request && request.generation !== gatewayPickerGeneration(key)) return Promise.resolve(undefined);
	const epoch = epochs.get(key) ?? 0;
	const source = request?.source ?? conversationBinding(key)?.source;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (value: string | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			opts?.signal?.removeEventListener("abort", cancel);
			if (inputs.get(key)?.resolve === done) inputs.delete(key);
			dialogs.get(key)?.delete(cancel);
			if (error !== undefined) reject(error);
			else resolve(value);
		};
		const done = (value: string | undefined) => finish(value);
		const cancel = () => done(undefined);
		const timeout = setTimeout(cancel, opts?.timeout ?? 300_000);
		const set = dialogs.get(key) ?? new Set();
		set.add(cancel);
		dialogs.set(key, set);
		opts?.signal?.addEventListener("abort", cancel, { once: true });
		if (opts?.signal?.aborted) {
			cancel();
			return;
		}
		void show(
			done,
			() => !settled && (epochs.get(key) ?? 0) === epoch && !!source && canDeliverGatewayText(key, source),
		).catch((error) => {
			finish(undefined, error);
		});
	});
}

export function gatewaySelect(
	key: string,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
	request?: GatewayDialogRequest,
): Promise<string | undefined> {
	return dialog(
		key,
		opts,
		async (done, valid) => {
			const { adapter, source: destination } = gatewayDestination(key);
			const source = request?.source ?? destination;
			const result = await createPicker(
				adapter,
				source,
				{
					kind: "dialog",
					generation: request?.generation,
					sessionKey: key,
					invokerId: source.userId,
					title,
					items: options.map((value) => ({ label: value, value })),
					validate: valid,
					onCancel: () => done(undefined),
					resolve: async (item) => {
						done(item.value);
						return { done: true, text: `${title}\n${item.value}` };
					},
				},
				{ threadId: source.threadId },
			);
			if (!result.success) throw new Error(result.error ?? "Could not send picker.");
		},
		request,
	);
}

export function gatewayInput(
	key: string,
	title: string,
	placeholder?: string,
	opts?: ExtensionUIDialogOptions,
	request?: GatewayDialogRequest,
): Promise<string | undefined> {
	if (inputs.has(key)) return Promise.reject(new Error("Answer or cancel the existing question first."));
	const epoch = gatewayEpoch(key);
	return dialog(
		key,
		opts,
		async (done, valid) => {
			if (!valid()) {
				done(undefined);
				return;
			}
			const source = request?.source ?? gatewayDestination(key).source;
			inputs.set(key, { userId: source.userId, resolve: done });
			await sendGatewayNotice(
				key,
				`${title}${placeholder ? `\n${placeholder}` : ""}\nReply with text, or /cancel.`,
				"notice",
				epoch,
			);
		},
		request,
	);
}

export function createGatewayUI(key: string): ExtensionUIContext {
	const identity = sessionIdentity(key);
	const source = conversationBinding(key)?.source;
	const valid = () => sessionIdentity(key) === identity && !!source && canDeliverGatewayText(key, source);
	return {
		...noOpUIContext,
		select: (title, options, opts) =>
			valid() ? gatewaySelect(key, title, options, opts) : Promise.resolve(undefined),
		confirm: async (title, message, opts) =>
			valid() && (await gatewaySelect(key, `${title}\n${message}`, ["Approve", "Decline"], opts)) === "Approve",
		input: (title, placeholder, opts) =>
			valid() ? gatewayInput(key, title, placeholder, opts) : Promise.resolve(undefined),
		editor: (title, prefill) => (valid() ? gatewayInput(key, title, prefill) : Promise.resolve(undefined)),
		notify: (message) => {
			if (valid()) void sendGatewayNotice(key, message).catch(() => {});
		},
		custom: async () => {
			throw new Error(
				"This command requires the terminal interface. Use the gateway's text commands or button pickers.",
			);
		},
		pasteToEditor: (text) => {
			if (valid()) void sendGatewayNotice(key, text).catch(() => {});
		},
		setEditorText: (text) => {
			if (valid()) void sendGatewayNotice(key, text).catch(() => {});
		},
	};
}
