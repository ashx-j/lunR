import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildHostHtmlTemplate } from "../src/builtin-extensions/pi-mcp-adapter/host-html-template.ts";
import { McpOAuthProvider } from "../src/builtin-extensions/pi-mcp-adapter/mcp-oauth-provider.ts";

const fake = vi.hoisted(() => ({ clients: [] as Array<{ name: string; version: string }> }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		constructor(info: { name: string; version: string }) {
			fake.clients.push(info);
		}
		async connect() {}
		async close() {}
		async listTools() {
			return { tools: [] };
		}
		async listResources() {
			return { resources: [] };
		}
		setNotificationHandler() {}
	},
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		async close() {}
	},
}));

import { McpServerManager } from "../src/builtin-extensions/pi-mcp-adapter/server-manager.ts";

describe("MCP client identity", () => {
	it.each(["authorization_code", "client_credentials"] as const)(
		"identifies fresh %s registrations as lunR without inventing a website",
		(grantType) => {
			const provider = new McpOAuthProvider("fixture", "https://mcp.invalid", { grantType }, { onRedirect() {} });
			expect(provider.clientMetadata.client_name).toBe("lunR");
			expect(provider.clientMetadata).not.toHaveProperty("client_uri");
			expect(provider.clientMetadata.redirect_uris).toEqual(
				grantType === "authorization_code" ? [provider.redirectUrl] : [],
			);
		},
	);

	it("preserves configured metadata, registration IDs and redirect formats", async () => {
		const provider = new McpOAuthProvider(
			"fixture",
			"https://mcp.invalid",
			{
				clientId: "existing-client",
				clientName: "My client",
				clientUri: "https://example.invalid/client",
				redirectUri: "http://localhost:19876/custom-callback",
				scope: "read",
			},
			{ onRedirect() {} },
		);
		expect(await provider.clientInformation()).toEqual({ client_id: "existing-client", client_secret: undefined });
		expect(provider.clientMetadata).toMatchObject({
			client_name: "My client",
			client_uri: "https://example.invalid/client",
			redirect_uris: ["http://localhost:19876/custom-callback"],
			scope: "read",
		});
	});

	it("sends lunR names for both the probe and connected MCP client", async () => {
		fake.clients.length = 0;
		const manager = new McpServerManager();
		try {
			await manager.connect("fixture", { url: "https://mcp.invalid", oauth: false });
			expect(fake.clients.map(({ name }) => name)).toEqual(["lunR-mcp-fixture", "lunR-mcp-probe"]);
		} finally {
			await manager.closeAll();
		}
	});

	it("constructs the offline app bridge with lunR host metadata", () => {
		const html = buildHostHtmlTemplate({
			sessionToken: "fake-token",
			serverName: "fixture",
			toolName: "show",
			toolArgs: {},
			resource: { uri: "ui://fixture", mimeType: "text/html", html: "<p>fixture</p>", meta: {} },
			allowAttribute: "",
			requireToolConsent: false,
			cacheToolConsent: false,
		});
		const bridgeCode = html.slice(html.indexOf("const bridge = new AppBridge("), html.indexOf("bridge.oncalltool"));
		const constructed = vi.fn();
		runInNewContext(bridgeCode, {
			AppBridge: class {
				constructor(...args: unknown[]) {
					constructed(...args);
				}
			},
			HOST_CONTEXT: {},
		});
		expect(constructed.mock.calls[0][1]).toEqual({ name: "lunR", version: "1.0.0" });
	});
});
