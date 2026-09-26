import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { noOpUIContext } from "../core/extensions/runner.ts";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../core/extensions/types.ts";
import { runWithApprovalContext } from "./approval.ts";
import { isAuthorized, isGatewayOwner } from "./authz.ts";
import { createPicker } from "./buttons.ts";
import { loadGatewayConfig } from "./config.ts";
import { conversationBinding } from "./conversations.ts";
import { createPairingStore } from "./pairing.ts";
import { atomicJson } from "./service.ts";
import { splitMessage } from "./text.ts";
import type { MessageEvent, PlatformAdapter } from "./types.ts";

const epochs = new Map<string, number>();
const inputs = new Map<string, { userId: string; resolve: (value: string | undefined) => void }>();
const dialogs = new Map<string, Set<() => void>>();
let adapters = new Map<string, PlatformAdapter>();
let timer: ReturnType<typeof setInterval> | undefined;
let sending = false;
interface Outbound {
	id: string;
	key: string;
	epoch: number;
	text: string;
}
const path = () => join(getAgentDir(), "gateway-outbox.json");
let outbox: Outbound[] = [];

function canDeliver(key: string): boolean {
	const binding = conversationBinding(key);
	if (!binding) return false;
	const cfg = loadGatewayConfig();
	if (binding.owner && (binding.owner !== binding.source.userId || !isGatewayOwner(binding.source, cfg))) return false;
	return isAuthorized(binding.source, cfg, createPairingStore());
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
			outbox = JSON.parse(readFileSync(path(), "utf8")) as Outbound[];
		} catch {
			throw new Error("Gateway outbox is invalid. Restore it before starting.");
		}
	}
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		void flushOutbox();
	}, 3000);
	timer.unref();
	void flushOutbox();
}

export function stopGatewayPresenter(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
	for (const key of dialogs.keys()) invalidateGatewayDialogs(key);
	adapters = new Map();
}

export async function sendGatewayNotice(key: string, text: string): Promise<void> {
	const clean = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
	if (!clean || !canDeliver(key)) return;
	const { adapter } = gatewayDestination(key);
	for (const chunk of splitMessage(clean, adapter.maxMessageLength))
		outbox.push({ id: randomUUID(), key, epoch: epochs.get(key) ?? 0, text: chunk });
	atomicJson(path(), outbox);
	await flushOutbox();
}

async function flushOutbox(): Promise<void> {
	if (sending) return;
	sending = true;
	try {
		for (const item of [...outbox]) {
			if (!canDeliver(item.key)) {
				outbox = outbox.filter((v) => v.id !== item.id);
				atomicJson(path(), outbox);
				continue;
			}
			let target: ReturnType<typeof gatewayDestination>;
			try {
				target = gatewayDestination(item.key);
			} catch {
				continue;
			}
			const result = await target.adapter
				.send(target.source.chatId, item.text, { threadId: target.source.threadId })
				.catch(() => ({ success: false }));
			if (result.success) {
				outbox = outbox.filter((v) => v.id !== item.id);
				atomicJson(path(), outbox);
			} else break;
		}
	} finally {
		sending = false;
	}
}

export function invalidateGatewayDialogs(key: string): void {
	epochs.set(key, (epochs.get(key) ?? 0) + 1);
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

function dialog(
	key: string,
	opts: ExtensionUIDialogOptions | undefined,
	show: (done: (value: string | undefined) => void, valid: () => boolean) => Promise<void>,
): Promise<string | undefined> {
	const epoch = epochs.get(key) ?? 0;
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (value: string | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			opts?.signal?.removeEventListener("abort", cancel);
			inputs.delete(key);
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
		void show(done, () => !settled && (epochs.get(key) ?? 0) === epoch && canDeliver(key)).catch((error) => {
			finish(undefined, error);
		});
	});
}

export function gatewaySelect(
	key: string,
	title: string,
	options: string[],
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	return dialog(key, opts, async (done, valid) => {
		const { adapter, source } = gatewayDestination(key);
		const result = await createPicker(
			adapter,
			source,
			{
				kind: "dialog",
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
	});
}

export function gatewayInput(
	key: string,
	title: string,
	placeholder?: string,
	opts?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	if (inputs.has(key)) return Promise.reject(new Error("Answer or cancel the existing question first."));
	return dialog(key, opts, async (done) => {
		const { source } = gatewayDestination(key);
		inputs.set(key, { userId: source.userId, resolve: done });
		await sendGatewayNotice(key, `${title}${placeholder ? `\n${placeholder}` : ""}\nReply with text, or /cancel.`);
	});
}

export function createGatewayUI(key: string): ExtensionUIContext {
	return {
		...noOpUIContext,
		select: (title, options, opts) => gatewaySelect(key, title, options, opts),
		confirm: async (title, message, opts) =>
			(await gatewaySelect(key, `${title}\n${message}`, ["Approve", "Decline"], opts)) === "Approve",
		input: (title, placeholder, opts) => gatewayInput(key, title, placeholder, opts),
		editor: (title, prefill) => gatewayInput(key, title, prefill),
		notify: (message) => {
			void sendGatewayNotice(key, message).catch(() => {});
		},
		custom: async () => {
			throw new Error(
				"This command requires the terminal interface. Use the gateway's text commands or button pickers.",
			);
		},
		pasteToEditor: (text) => {
			void sendGatewayNotice(key, text).catch(() => {});
		},
		setEditorText: (text) => {
			void sendGatewayNotice(key, text).catch(() => {});
		},
	};
}
