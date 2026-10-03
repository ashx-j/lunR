import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredClientInfo, StoredTokens } from "../src/builtin-extensions/pi-mcp-adapter/mcp-auth.ts";
import type { McpOAuthProvider } from "../src/builtin-extensions/pi-mcp-adapter/mcp-oauth-provider.ts";

const fake = vi.hoisted(() => ({
	stored: new Map<
		string,
		{ serverUrl?: string; clientInfo?: StoredClientInfo; tokens?: StoredTokens; oauthState?: string }
	>(),
	providers: [] as McpOAuthProvider[],
	transports: [] as Array<{ close: ReturnType<typeof vi.fn>; finishAuth: ReturnType<typeof vi.fn> }>,
	callbacks: new Map<string, { resolve(code: string): void; reject(error: Error): void }>(),
	owners: new Set<symbol>(),
	authGate: Promise.resolve(),
	bindGate: Promise.resolve(),
}));
vi.mock("open", () => ({ default: vi.fn(async () => {}) }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
	UnauthorizedError: class extends Error {},
	auth: vi.fn(async (provider: McpOAuthProvider) => {
		fake.providers.push(provider);
		await fake.authGate;
		if (!(await provider.clientInformation())) {
			await provider.saveClientInformation({
				client_id: `client-${fake.providers.indexOf(provider)}`,
				redirect_uris: provider.redirectUrl ? [provider.redirectUrl] : [],
			});
		}
		if (!provider.redirectUrl) {
			await provider.saveTokens({ access_token: "fake-token", token_type: "Bearer" });
			return "AUTHORIZED";
		}
		await provider.saveCodeVerifier(`verifier-${fake.providers.indexOf(provider)}`);
		await provider.redirectToAuthorization(
			new URL(`https://oauth.invalid/authorize?state=${await provider.state()}`),
		);
		return "REDIRECT";
	}),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		close = vi.fn(async () => {});
		finishAuth = vi.fn(async () => {});
		constructor(_url: URL, options: { authProvider: McpOAuthProvider }) {
			this.finishAuth.mockImplementation(async () => {
				await options.authProvider.codeVerifier();
				if (!(await options.authProvider.clientInformation())) throw new Error("Lost flow registration");
				await options.authProvider.saveTokens({ access_token: "fake-token", token_type: "Bearer" });
			});
			fake.transports.push(this);
		}
	},
}));
vi.mock("../src/builtin-extensions/pi-mcp-adapter/mcp-auth.ts", () => ({
	getAuthForUrl: vi.fn(async (name: string, url: string) => {
		const stored = fake.stored.get(name);
		return stored?.serverUrl && stored.serverUrl !== url ? undefined : stored;
	}),
	updateOAuthState: vi.fn(),
	updateCodeVerifier: vi.fn(),
	clearOAuthState: vi.fn(),
	clearClientInfo: vi.fn(),
	clearCodeVerifier: vi.fn(),
	clearTokens: vi.fn(),
	clearAllCredentials: vi.fn(),
	updateTokens: vi.fn((name: string, tokens: StoredTokens, serverUrl: string) => {
		fake.stored.set(name, { ...fake.stored.get(name), serverUrl, tokens });
	}),
	updateClientInfo: vi.fn((name: string, clientInfo: StoredClientInfo, serverUrl: string) => {
		fake.stored.set(name, { serverUrl, clientInfo });
	}),
}));
vi.mock("../src/builtin-extensions/pi-mcp-adapter/mcp-callback-server.ts", () => ({
	acquireCallbackServerOwner: () => {
		const owner = Symbol();
		fake.owners.add(owner);
		return owner;
	},
	releaseCallbackServerOwner: vi.fn(async (owner: symbol) => {
		fake.owners.delete(owner);
	}),
	ensureCallbackServer: vi.fn(async () => {
		await fake.bindGate;
	}),
	releaseCallbackServer: vi.fn(),
	cancelPendingCallback: vi.fn((state: string) => {
		fake.callbacks.get(state)?.reject(new Error("Authorization cancelled"));
		fake.callbacks.delete(state);
	}),
	waitForCallback: vi.fn(
		(state: string) =>
			new Promise<string>((resolve, reject) => {
				fake.callbacks.set(state, { resolve, reject });
			}),
	),
}));

import {
	clearAllCredentials,
	clearClientInfo,
	clearOAuthState,
	updateCodeVerifier,
	updateOAuthState,
	updateTokens,
} from "../src/builtin-extensions/pi-mcp-adapter/mcp-auth.ts";
import { createMcpAuthFlow } from "../src/builtin-extensions/pi-mcp-adapter/mcp-auth-flow.ts";
import { ensureCallbackServer } from "../src/builtin-extensions/pi-mcp-adapter/mcp-callback-server.ts";

const sessions: ReturnType<typeof createMcpAuthFlow>[] = [];
function session() {
	const flow = createMcpAuthFlow();
	sessions.push(flow);
	return flow;
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

beforeEach(() => {
	vi.clearAllMocks();
	fake.stored.clear();
	fake.providers.length = 0;
	fake.transports.length = 0;
	fake.authGate = Promise.resolve();
	fake.bindGate = Promise.resolve();
});
afterEach(async () => {
	await Promise.all(sessions.splice(0).map((flow) => flow.shutdown()));
	vi.useRealTimers();
});

describe("MCP OAuth session ownership", () => {
	it.each([false, true])("lets the second session finish after the first closes, same name = %s", async (sameName) => {
		const first = session();
		const second = session();
		const name = sameName ? "shared" : "second";
		await first.startAuth("shared", "https://first.invalid/mcp");
		await second.startAuth(name, "https://second.invalid/mcp");
		expect(await fake.providers[0].state()).not.toBe(await fake.providers[1].state());
		expect(await fake.providers[1].codeVerifier()).toBe("verifier-1");
		await first.shutdown();
		expect(fake.transports[0].close).toHaveBeenCalledOnce();
		expect(fake.transports[1].close).not.toHaveBeenCalled();
		await expect(second.completeAuthFromInput(name, "code-second")).resolves.toBe("authenticated");
		expect(fake.transports[1].finishAuth).toHaveBeenCalledWith("code-second");
		expect(updateOAuthState).not.toHaveBeenCalled();
		expect(updateCodeVerifier).not.toHaveBeenCalled();
		expect(clearOAuthState).not.toHaveBeenCalled();
	});

	it("deduplicates browser authentication only within the same session", async () => {
		const first = session();
		const second = session();
		const opts = { onAuthorizationUrl: vi.fn() };
		const a = first.authenticate("shared", "https://same.invalid/mcp", undefined, opts);
		const aDuplicate = first.authenticate("shared", "https://same.invalid/mcp", undefined, opts);
		const b = second.authenticate("shared", "https://same.invalid/mcp", undefined, opts);
		const aRejected = expect(a).rejects.toThrow("cancelled");
		const duplicateRejected = expect(aDuplicate).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(fake.callbacks.size).toBe(2));
		const bState = await fake.providers[1].state();
		await first.shutdown();
		await aRejected;
		await duplicateRejected;
		expect(fake.transports[0].close).toHaveBeenCalledOnce();
		expect(fake.callbacks.has(bState)).toBe(true);
		fake.callbacks.get(bState)!.resolve("callback-second");
		await expect(b).resolves.toBe("authenticated");
		expect(fake.providers).toHaveLength(2);
	});

	it.each(["bind", "sdk"])("rejects late initialization after closing during %s", async (phase) => {
		const held = gate();
		if (phase === "bind") fake.bindGate = held.promise;
		else fake.authGate = held.promise;
		const flow = session();
		const start = flow.startAuth("shared", "https://same.invalid/mcp");
		const rejected = expect(start).rejects.toThrow("cancelled");
		await vi.waitFor(() =>
			phase === "bind" ? expect(ensureCallbackServer).toHaveBeenCalled() : expect(fake.providers).toHaveLength(1),
		);
		await flow.shutdown();
		held.release();
		await rejected;
		expect(fake.transports).toHaveLength(0);
		await expect(flow.startAuth("other", "https://other.invalid/mcp")).rejects.toThrow("closed");
	});

	it("cancels only the departing owner's client-credentials request without binding callbacks", async () => {
		const held = gate();
		fake.authGate = held.promise;
		const first = session();
		const second = session();
		const definition = {
			url: "https://same.invalid/mcp",
			oauth: { grantType: "client_credentials" as const, clientId: "registered-id" },
		};
		const a = first.authenticate("shared", definition.url, definition);
		const rejected = expect(a).rejects.toThrow("cancelled");
		const b = second.authenticate("shared", definition.url, definition);
		await vi.waitFor(() => expect(fake.providers).toHaveLength(2));
		await first.shutdown();
		held.release();
		await rejected;
		await expect(b).resolves.toBe("authenticated");
		expect(ensureCallbackServer).not.toHaveBeenCalled();
		expect(updateTokens).toHaveBeenCalledOnce();
	});

	it("invalidates provider writes as soon as shutdown begins", async () => {
		const flow = session();
		await flow.startAuth("server", "https://same.invalid/mcp");
		const closing = flow.shutdown();
		await expect(fake.providers[0].saveTokens({ access_token: "fake-token", token_type: "Bearer" })).rejects.toThrow(
			"cancelled",
		);
		await closing;
		expect(updateTokens).not.toHaveBeenCalled();
	});

	it("rejects late token writes and completion after shutdown", async () => {
		const held = gate();
		const flow = session();
		await flow.startAuth("server", "https://same.invalid/mcp");
		fake.transports[0].finishAuth.mockImplementation(async () => {
			await held.promise;
			await fake.providers[0].saveTokens({ access_token: "fake-token", token_type: "Bearer" });
		});
		const completing = flow.completeAuth("server", "code");
		const rejected = expect(completing).rejects.toThrow("cancelled");
		await flow.shutdown();
		held.release();
		await rejected;
		expect(updateTokens).not.toHaveBeenCalled();
	});

	it("restarts a manual flow without replacing another owner's same-name flow", async () => {
		const first = session();
		const second = session();
		await first.startAuth("shared", "https://same.invalid/mcp");
		await second.startAuth("shared", "https://same.invalid/mcp");
		await first.startAuth("shared", "https://same.invalid/mcp");
		expect(fake.transports[0].close).toHaveBeenCalledOnce();
		expect(fake.transports[1].close).not.toHaveBeenCalled();
		await expect(second.completeAuth("shared", "second-code")).resolves.toBe("authenticated");
		await expect(first.completeAuth("shared", "first-code")).resolves.toBe("authenticated");
	});

	it("times out only its own manual flow", async () => {
		vi.useFakeTimers();
		const first = session();
		const second = session();
		await first.startAuth("shared", "https://same.invalid/mcp");
		await vi.advanceTimersByTimeAsync(1000);
		await second.startAuth("shared", "https://same.invalid/mcp");
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1000);
		expect(fake.transports[0].close).toHaveBeenCalledOnce();
		expect(fake.transports[1].close).not.toHaveBeenCalled();
		await expect(second.completeAuth("shared", "code")).resolves.toBe("authenticated");
	});

	it("retains cached registration IDs while concurrent callback binding yields", async () => {
		const held = gate();
		fake.bindGate = held.promise;
		const first = session();
		const second = session();
		fake.stored.set("shared", {
			serverUrl: "https://first.invalid/mcp",
			clientInfo: { clientId: "legacy-first", redirectUris: ["http://localhost:19876/callback"] },
		});
		const a = first.startAuth("shared", "https://first.invalid/mcp");
		await vi.waitFor(() => expect(ensureCallbackServer).toHaveBeenCalledOnce());
		fake.stored.set("shared", {
			serverUrl: "https://second.invalid/mcp",
			clientInfo: { clientId: "legacy-second", redirectUris: ["http://localhost:19876/callback"] },
		});
		const b = second.startAuth("shared", "https://second.invalid/mcp");
		await vi.waitFor(() => expect(ensureCallbackServer).toHaveBeenCalledTimes(2));
		held.release();
		await a;
		await b;
		expect(await fake.providers[0].clientInformation()).toMatchObject({ client_id: "legacy-first" });
		expect(await fake.providers[1].clientInformation()).toMatchObject({ client_id: "legacy-second" });
	});

	it("keeps each endpoint's registration through same-name credential replacement", async () => {
		const first = session();
		const second = session();
		await first.startAuth("shared", "https://first.invalid/mcp");
		await second.startAuth("shared", "https://second.invalid/mcp");
		expect(await fake.providers[0].clientInformation()).toMatchObject({ client_id: "client-0" });
		expect(await fake.providers[1].clientInformation()).toMatchObject({ client_id: "client-1" });
		await second.shutdown();
		await expect(first.completeAuth("shared", "first-code")).resolves.toBe("authenticated");
		expect(fake.stored.get("shared")).toMatchObject({
			serverUrl: "https://first.invalid/mcp",
			clientInfo: { clientId: "client-0" },
			tokens: { accessToken: "fake-token" },
		});
	});

	it("keeps cached registrations and their exact redirect when no tokens exist", async () => {
		fake.stored.set("legacy", {
			clientInfo: { clientId: "pi-registered-id", redirectUris: ["http://localhost:19876/callback"] },
		});
		await session().startAuth("legacy", "https://same.invalid/mcp");
		expect(await fake.providers[0].clientInformation()).toEqual({
			client_id: "pi-registered-id",
			client_secret: undefined,
		});
		expect(fake.providers[0].redirectUrl).toBe("http://localhost:19876/callback");
		expect(clearClientInfo).not.toHaveBeenCalled();
		expect(clearAllCredentials).not.toHaveBeenCalled();
		expect(ensureCallbackServer).toHaveBeenCalledWith(
			expect.objectContaining({ strictPort: true, port: 19876, callbackPath: "/callback" }),
		);
	});

	it("rejects another owner's redirect state without consuming the pending flow", async () => {
		const first = session();
		const second = session();
		await first.startAuth("shared", "https://same.invalid/mcp");
		await second.startAuth("shared", "https://same.invalid/mcp");
		await expect(
			second.completeAuthFromInput(
				"shared",
				`http://localhost:19876/callback?code=code&state=${await fake.providers[0].state()}`,
			),
		).rejects.toThrow("state mismatch");
		expect(fake.transports[1].finishAuth).not.toHaveBeenCalled();
		await expect(second.completeAuth("shared", "code")).resolves.toBe("authenticated");
	});
});
