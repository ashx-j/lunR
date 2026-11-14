import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeLoopback, ClaudeCodeTripwire } from "../src/api/claude-code-loopback.ts";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

async function open(): Promise<ClaudeCodeLoopback> {
	const loopback = await ClaudeCodeLoopback.open([
		{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
	]);
	closers.push(() => loopback.close());
	return loopback;
}

const mcp = (loopback: ClaudeCodeLoopback, body: object) =>
	fetch(loopback.mcpUrl, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});

/** Sends raw bytes to a loopback port and returns whatever comes back before the socket closes. */
function rawRequest(port: number, request: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const socket = connect(port, "127.0.0.1", () => socket.end(request));
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk;
		});
		socket.on("close", () => resolve(text));
		socket.on("error", (error: NodeJS.ErrnoException) =>
			error.code === "ECONNRESET" ? resolve(text) : reject(error),
		);
	});
}

describe("Claude Code loopback", () => {
	it("answers a malformed request target instead of throwing", async () => {
		const loopback = await open();
		const reply = await rawRequest(Number(new URL(loopback.mcpUrl).port), "GET // HTTP/1.1\r\nHost: x\r\n\r\n");
		expect(reply).toMatch(/^HTTP\/1\.1 404/);
		expect((await mcp(loopback, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
	});

	it("refuses browser origins, other paths, and Messages requests", async () => {
		const loopback = await open();
		const fromPage = await fetch(loopback.mcpUrl, {
			method: "POST",
			headers: { origin: "https://example.com" },
			body: "{}",
		});
		expect(fromPage.status).toBe(404);
		const { origin } = new URL(loopback.mcpUrl);
		expect((await fetch(`${origin}/guess/mcp`, { method: "POST", body: "{}" })).status).toBe(404);
		expect((await fetch(`${origin}/v1/messages`, { method: "POST", body: "{}" })).status).toBe(404);
	});

	it("lists lunR's tools over MCP and refuses every call", async () => {
		const loopback = await open();
		const initialize = await mcp(loopback, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		expect((await initialize.json()).result.protocolVersion).toBe("2025-06-18");
		expect((await mcp(loopback, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
		const list = await (await mcp(loopback, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
		expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read"]);
		const call = await (
			await mcp(loopback, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read" } })
		).json();
		expect(call.result.isError).toBe(true);
		expect((await fetch(loopback.mcpUrl)).status).toBe(405);
	});
});

describe("Claude Code tripwire", () => {
	it("counts a request and drops it without answering", async () => {
		const tripwire = await ClaudeCodeTripwire.open();
		closers.push(() => tripwire.close());
		expect(tripwire.tripped).toBe(false);
		const reply = await rawRequest(
			Number(new URL(tripwire.baseUrl).port),
			"POST /v1/messages HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer secret\r\nContent-Length: 2\r\n\r\n{}",
		);
		expect(reply).toBe("");
		expect(tripwire.tripped).toBe(true);
	});

	it("lets Claude Code's warm-up through uncounted", async () => {
		const tripwire = await ClaudeCodeTripwire.open();
		closers.push(() => tripwire.close());
		const reply = await rawRequest(
			Number(new URL(tripwire.baseUrl).port),
			"HEAD /api/hello HTTP/1.1\r\nHost: x\r\n\r\n",
		);
		expect(reply).toBe("");
		expect(tripwire.tripped).toBe(false);
	});

	it("drops get_context_usage token counts uncounted but still counts a generation", async () => {
		const tripwire = await ClaudeCodeTripwire.open();
		closers.push(() => tripwire.close());
		const port = Number(new URL(tripwire.baseUrl).port);
		await rawRequest(port, "POST /v1/messages/count_tokens?beta=true HTTP/1.1\r\nHost: x\r\n\r\n{}");
		expect(tripwire.tripped).toBe(false);
		await rawRequest(port, "POST /v1/messages?beta=true HTTP/1.1\r\nHost: x\r\n\r\n{}");
		expect(tripwire.tripped).toBe(true);
	});
});
