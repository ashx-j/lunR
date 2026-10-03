import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpOAuthProvider } from "../src/builtin-extensions/pi-mcp-adapter/mcp-oauth-provider.ts";

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
				close: vi.fn((done: () => void) => done()),
				address: () => ({ port: 23456 }),
				unref: vi.fn(),
			});
			fake.servers.push(server);
			return server;
		},
	};
});
vi.mock("open", () => ({ default: vi.fn(async () => {}) }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	UnauthorizedError: class extends Error {},
	auth: vi.fn(async (provider: McpOAuthProvider) => {
		await provider.saveCodeVerifier("inert-pkce");
		await provider.redirectToAuthorization(new URL(`https://oauth.invalid/auth?state=${await provider.state()}`));
		return "REDIRECT";
	}),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		close = vi.fn(async () => {});
		finishAuth = vi.fn(async () => {});
	},
}));
vi.mock("../src/builtin-extensions/pi-mcp-adapter/mcp-auth.ts", () => ({
	getAuthForUrl: async () => undefined,
	updateClientInfo: vi.fn(),
	updateTokens: vi.fn(),
	updateCodeVerifier: vi.fn(),
	updateOAuthState: vi.fn(),
	clearAllCredentials: vi.fn(),
	clearClientInfo: vi.fn(),
	clearTokens: vi.fn(),
}));

import { createMcpAuthFlow } from "../src/builtin-extensions/pi-mcp-adapter/mcp-auth-flow.ts";
import {
	getPendingAuthCount,
	stopCallbackServer,
	waitForCallback,
} from "../src/builtin-extensions/pi-mcp-adapter/mcp-callback-server.ts";

const owners: ReturnType<typeof createMcpAuthFlow>[] = [];
function owner() {
	const flow = createMcpAuthFlow();
	owners.push(flow);
	return flow;
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const secondDefinition = {
	url: "https://second.invalid/mcp",
	oauth: { clientId: "inert-id", redirectUri: "http://localhost:23456/another-callback" },
};

afterEach(async () => {
	await Promise.all(owners.splice(0).map((flow) => flow.shutdown()));
	await stopCallbackServer();
	fake.servers.length = 0;
	fake.bindGate = Promise.resolve();
});

describe("OAuth flow cancellation across actual callback bookkeeping", () => {
	it.each(["during bind", "after bind"])(
		"lets the surviving owner change endpoint after departure %s",
		async (phase) => {
			const held = gate();
			if (phase === "during bind") fake.bindGate = held.promise;
			const first = owner(),
				second = owner();
			const start = first.startAuth("first", "https://first.invalid/mcp");
			const outcome = phase === "during bind" ? expect(start).rejects.toThrow("cancelled") : start;
			try {
				await vi.waitFor(() => expect(fake.servers).toHaveLength(1));
				if (phase === "after bind") await start;
				const closing = first.shutdown();
				fake.bindGate = Promise.resolve();
				held.release();
				await Promise.all([closing, outcome]);
				expect(getPendingAuthCount()).toBe(0);
				await expect(second.startAuth("second", secondDefinition.url, secondDefinition)).resolves.toMatchObject({
					authorizationUrl: expect.any(String),
				});
				expect(fake.servers).toHaveLength(1);
				expect(fake.servers[0].close).not.toHaveBeenCalled();
				await expect(second.completeAuth("second", "inert-code")).resolves.toBe("authenticated");
			} finally {
				held.release();
				await start.catch(() => {});
			}
		},
	);

	it("lets the same owner retry a canceled bind with another registered callback path", async () => {
		const held = gate();
		fake.bindGate = held.promise;
		const flow = owner();
		const start = flow.startAuth("first", "https://first.invalid/mcp");
		const rejected = expect(start).rejects.toThrow("cancelled");
		try {
			await vi.waitFor(() => expect(fake.servers).toHaveLength(1));
			await flow.removeAuth("first");
			fake.bindGate = Promise.resolve();
			held.release();
			await rejected;
			await expect(flow.startAuth("second", secondDefinition.url, secondDefinition)).resolves.toMatchObject({
				authorizationUrl: expect.any(String),
			});
		} finally {
			held.release();
			await start.catch(() => {});
		}
	});

	it("keeps another owner's queued reservation and callback when the first bind is canceled", async () => {
		const held = gate();
		fake.bindGate = held.promise;
		const first = owner(),
			second = owner();
		const start = first.startAuth("first", "https://first.invalid/mcp");
		const rejected = expect(start).rejects.toThrow("cancelled");
		let survivor: Promise<{ authorizationUrl: string }> | undefined;
		try {
			await vi.waitFor(() => expect(fake.servers).toHaveLength(1));
			survivor = second.startAuth("second", "https://second.invalid/mcp");
			const closing = first.shutdown();
			fake.bindGate = Promise.resolve();
			held.release();
			await Promise.all([closing, rejected]);
			const state = new URL((await survivor).authorizationUrl).searchParams.get("state")!;
			const callback = waitForCallback(state);
			const res = { writeHead: vi.fn(), end: vi.fn() };
			fake.servers[0].handler(
				{
					url: `/callback?code=inert-code&state=${state}`,
					headers: { host: "localhost:23456" },
				} as IncomingMessage,
				res as unknown as ServerResponse,
			);
			expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
			await expect(callback).resolves.toBe("inert-code");
			await expect(second.completeAuth("second", "inert-code")).resolves.toBe("authenticated");
			expect(fake.servers[0].close).not.toHaveBeenCalled();
		} finally {
			held.release();
			await start.catch(() => {});
			await survivor?.catch(() => {});
		}
	});
});
