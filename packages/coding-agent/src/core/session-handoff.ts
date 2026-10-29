import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionManager } from "./session-manager.ts";
import {
	canonicalSessionPath,
	isSessionOwnerDead,
	readSessionOwner,
	SessionOwnership,
	writeSessionJson,
} from "./session-ownership.ts";

export class SessionTransferError extends Error {
	readonly code: "busy" | "unsupported" | "timeout" | "changed" | "failed";
	constructor(message: string, code: SessionTransferError["code"] = "failed") {
		super(message);
		this.name = "SessionTransferError";
		this.code = code;
	}
}
interface TransferRequest {
	id: string;
	generation: string;
	requester: string;
	stop: boolean;
	expiresAt: number;
}
function transferPath(file: string): string {
	return `${canonicalSessionPath(file)}.transfer.json`;
}

export async function requestSessionTransfer(
	file: string,
	options: { stop?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
	options.signal?.throwIfAborted();
	const owner = readSessionOwner(file);
	if (!owner || isSessionOwnerDead(owner)) return;
	const path = transferPath(file);
	const request: TransferRequest = {
		id: randomUUID(),
		generation: owner.generation,
		requester: `${process.pid}:${randomUUID()}`,
		stop: options.stop === true,
		expiresAt: Date.now() + (options.timeoutMs ?? 15_000),
	};
	const publication = new SessionOwnership(`${path}.publication`);
	try {
		if (existsSync(path)) {
			const pending: TransferRequest = JSON.parse(readFileSync(path, "utf8"));
			if (!Number.isFinite(pending.expiresAt) || pending.expiresAt > Date.now())
				throw new SessionTransferError("Another transfer request is pending.", "busy");
			unlinkSync(path);
		}
		writeFileSync(path, JSON.stringify(request), { flag: "wx", mode: 0o600 });
	} finally {
		publication.release();
	}
	const responsePath = `${path}.${request.id}.response`;
	try {
		while (Date.now() < request.expiresAt) {
			options.signal?.throwIfAborted();
			const current = readSessionOwner(file);
			if (!current || isSessionOwnerDead(current)) return;
			if (current.generation !== owner.generation)
				throw new SessionTransferError("Another runtime acquired the session. Retry the transfer.", "changed");
			if (existsSync(responsePath)) {
				const response = JSON.parse(readFileSync(responsePath, "utf8"));
				throw new SessionTransferError(
					response.error ?? "Owner did not release the session.",
					response.code ?? "failed",
				);
			}
			await delay(100, undefined, { signal: options.signal });
		}
		throw new SessionTransferError(
			"Owner did not release the session. It may be busy or running an older lunR. Close it normally or retry; no takeover occurred.",
			"timeout",
		);
	} finally {
		try {
			const cleanup = new SessionOwnership(`${path}.publication`);
			try {
				if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).id === request.id) unlinkSync(path);
			} finally {
				cleanup.release();
			}
		} catch {}
		try {
			unlinkSync(responsePath);
		} catch {}
	}
}

export function registerTransferHandler(
	manager: SessionManager,
	handler: (request: { stop: boolean; signal: AbortSignal }) => Promise<void>,
): () => void {
	const owner = manager.getOwnership()?.owner;
	if (!owner) return () => {};
	const path = transferPath(owner.file);
	let handling = false;
	let lastId: string | undefined;
	const timer = setInterval(() => {
		if (handling || !existsSync(path)) return;
		let request: TransferRequest;
		try {
			request = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return;
		}
		if (request.id === lastId || request.generation !== owner.generation || request.expiresAt <= Date.now()) return;
		lastId = request.id;
		handling = true;
		const controller = new AbortController();
		const watchRequest = setInterval(() => {
			try {
				if (Date.now() >= request.expiresAt || JSON.parse(readFileSync(path, "utf8")).id !== request.id)
					controller.abort();
			} catch {
				controller.abort();
			}
		}, 50);
		watchRequest.unref();
		void (async () => {
			try {
				manager.assertWritable();
				await handler({ stop: request.stop === true, signal: controller.signal });
				if (readSessionOwner(owner.file)?.generation === owner.generation)
					throw new SessionTransferError("Owner did not release the session.");
			} catch (error) {
				if (existsSync(path))
					writeSessionJson(`${path}.${request.id}.response`, {
						error: error instanceof Error ? error.message : String(error),
						code: error instanceof SessionTransferError ? error.code : "failed",
					});
			} finally {
				clearInterval(watchRequest);
				handling = false;
			}
		})().catch(() => {});
	}, 100);
	timer.unref();
	return () => clearInterval(timer);
}
