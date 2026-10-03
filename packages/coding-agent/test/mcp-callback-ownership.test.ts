import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	bindGate: Promise.resolve(),
	servers: [] as Array<{
		close: ReturnType<typeof vi.fn>;
		handler: (req: IncomingMessage, res: ServerResponse) => void;
	}>,
}));
vi.mock("http", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		createServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
			const server = Object.assign(new EventEmitter(), {
				handler,
				listen: vi.fn((_port: number, _host: string, ready: () => void) => {
					void fake.bindGate.then(ready, (error: Error) => server.emit("error", error));
				}),
				close: vi.fn((closed: () => void) => {
					closed();
				}),
				address: () => ({ port: 23456 }),
				unref: vi.fn(),
			});
			fake.servers.push(server);
			return server;
		},
	};
});

import {
	acquireCallbackServerOwner,
	cancelPendingCallback,
	ensureCallbackServer,
	getPendingAuthCount,
	isCallbackServerRunning,
	releaseCallbackServer,
	releaseCallbackServerOwner,
	stopCallbackServer,
	waitForCallback,
} from "../src/builtin-extensions/pi-mcp-adapter/mcp-callback-server.ts";

const owners: symbol[] = [];
function owner() {
	const token = acquireCallbackServerOwner();
	owners.push(token);
	return token;
}
function callback(state: string) {
	const res = { writeHead: vi.fn(), end: vi.fn() };
	fake.servers
		.at(-1)!
		.handler(
			{ url: `/callback?code=second-code&state=${state}`, headers: { host: "localhost:23456" } } as IncomingMessage,
			res as unknown as ServerResponse,
		);
	return res;
}
afterEach(async () => {
	await Promise.all(owners.splice(0).map(releaseCallbackServerOwner));
	await stopCallbackServer();
	fake.servers.length = 0;
	fake.bindGate = Promise.resolve();
});

describe("shared MCP OAuth callback listener", () => {
	it("keeps the other owner's callback live and closes only after the final owner", async () => {
		const first = owner();
		const second = owner();
		await Promise.all([
			ensureCallbackServer({ owner: first, oauthState: "first", reserveState: true }),
			ensureCallbackServer({ owner: second, oauthState: "second", reserveState: true }),
		]);
		expect(fake.servers).toHaveLength(1);
		const a = waitForCallback("first");
		const b = waitForCallback("second");
		const aRejected = expect(a).rejects.toThrow("cancelled");
		cancelPendingCallback("first");
		releaseCallbackServer("first");
		await releaseCallbackServerOwner(first);
		await aRejected;
		expect(isCallbackServerRunning()).toBe(true);
		expect(fake.servers[0].close).not.toHaveBeenCalled();
		expect(callback("first").writeHead).toHaveBeenCalledWith(400, expect.anything());
		expect(getPendingAuthCount()).toBe(1);
		callback("second");
		await expect(b).resolves.toBe("second-code");
		expect(isCallbackServerRunning()).toBe(true);
		await releaseCallbackServerOwner(second);
		expect(isCallbackServerRunning()).toBe(false);
		expect(fake.servers[0].close).toHaveBeenCalledOnce();
	});

	it("releases an owner even when the binding it waited for fails", async () => {
		let failBind!: (error: Error) => void;
		fake.bindGate = new Promise<void>((_resolve, reject) => {
			failBind = reject;
		});
		const first = owner();
		const binding = ensureCallbackServer({ owner: first });
		const rejected = expect(binding).rejects.toThrow("synthetic bind failure");
		const closing = releaseCallbackServerOwner(first);
		fake.bindGate = Promise.resolve();
		failBind(new Error("synthetic bind failure"));
		await rejected;
		await closing;
		await expect(ensureCallbackServer({ owner: first })).rejects.toThrow("closed");
		const second = owner();
		await ensureCallbackServer({ owner: second });
		await releaseCallbackServerOwner(second);
		expect(isCallbackServerRunning()).toBe(false);
	});

	it("serializes final-owner shutdown with binding and rejects stale initialization", async () => {
		let finishBind!: () => void;
		fake.bindGate = new Promise<void>((resolve) => {
			finishBind = resolve;
		});
		const first = owner();
		const binding = ensureCallbackServer({ owner: first, oauthState: "first", reserveState: true });
		const closing = releaseCallbackServerOwner(first);
		expect(fake.servers).toHaveLength(1);
		finishBind();
		await binding;
		await closing;
		expect(isCallbackServerRunning()).toBe(false);
		await expect(ensureCallbackServer({ owner: first })).rejects.toThrow("closed");
		const second = owner();
		await ensureCallbackServer({ owner: second });
		expect(isCallbackServerRunning()).toBe(true);
		expect(fake.servers).toHaveLength(2);
	});
});
