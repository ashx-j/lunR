import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeLoopback } from "../src/api/claude-code-loopback.ts";

const closers: (() => void)[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const close of closers.splice(0)) close();
});

async function fixtureUpstream(): Promise<{ url: string; requests: string[] }> {
	const requests: string[] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			requests.push(`${req.url} ${req.headers.authorization} ${body}`);
			res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fixture" });
			res.end("event: ping\ndata: {}\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => server.close());
	const address = server.address();
	return { url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, requests };
}

async function open(upstream?: string): Promise<ClaudeCodeLoopback> {
	const loopback = await ClaudeCodeLoopback.open({
		timeoutMs: 5000,
		upstream,
		tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
	});
	closers.push(() => loopback.close());
	return loopback;
}

// Records what reaches a fake HTTP proxy: plain requests by absolute URL, HTTPS tunnels by CONNECT target.
async function fakeProxy(): Promise<{ url: string; seen: string[] }> {
	const seen: string[] = [];
	const server = createServer((req, res) => {
		seen.push(`${req.method} ${req.url}`);
		req.resume();
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("via proxy");
	});
	server.on("connect", (req, socket) => {
		seen.push(`CONNECT ${req.url}`);
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => {
		server.close();
		server.closeAllConnections();
	});
	const address = server.address();
	return { url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, seen };
}

function setProxyEnv(proxy: string, noProxy = ""): void {
	for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
		vi.stubEnv(name, name.toLowerCase().startsWith("all") ? "" : proxy);
	}
	vi.stubEnv("NO_PROXY", noProxy);
	vi.stubEnv("no_proxy", "");
}

const mcp = (loopback: ClaudeCodeLoopback, body: object) =>
	fetch(loopback.mcpUrl, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});

describe("Claude Code loopback", () => {
	it("answers a malformed request target instead of throwing", async () => {
		const loopback = await open();
		const { port } = new URL(loopback.baseUrl);
		const reply = await new Promise<string>((resolve, reject) => {
			const socket = connect(Number(port), "127.0.0.1", () => socket.end("GET // HTTP/1.1\r\nHost: x\r\n\r\n"));
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk;
			});
			socket.on("end", () => resolve(text));
			socket.on("error", reject);
		});
		expect(reply).toMatch(/^HTTP\/1\.1 404/);
		expect((await mcp(loopback, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
	});

	it("forwards one Messages request to both Claude Code and lunR, then refuses more", async () => {
		const upstream = await fixtureUpstream();
		const loopback = await open(upstream.url);
		const first = await fetch(`${loopback.baseUrl}/v1/messages?beta=true`, {
			method: "POST",
			headers: { authorization: "Bearer from-claude-code" },
			body: '{"model":"x"}',
		});
		expect(await first.text()).toBe("event: ping\ndata: {}\n\n");
		const admitted = await loopback.response;
		expect(admitted.status).toBe(200);
		expect(admitted.headers.get("request-id")).toBe("req_fixture");
		expect(await new Response(admitted.body).text()).toBe("event: ping\ndata: {}\n\n");
		expect(upstream.requests).toEqual(['/v1/messages?beta=true Bearer from-claude-code {"model":"x"}']);

		const retry = await fetch(`${loopback.baseUrl}/v1/messages`, { method: "POST", body: "{}" });
		expect(retry.status).toBe(400);
		expect(await retry.text()).toContain("LUNR_MODEL_ADMISSION_CONSUMED");
		expect(loopback.denied).toBe(1);
		expect(upstream.requests).toHaveLength(1);
	});

	it("refuses browser origins, unknown paths, and non-HTTPS upstreams", async () => {
		const loopback = await open();
		const fromPage = await fetch(`${loopback.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { origin: "https://example.com" },
			body: "{}",
		});
		expect(fromPage.status).toBe(404);
		expect(
			(await fetch(`${loopback.baseUrl.replace(/\/[^/]+$/, "/guess")}/v1/messages`, { method: "POST" })).status,
		).toBe(404);
		expect(loopback.admitted).toBe(false);
		await expect(ClaudeCodeLoopback.open({ timeoutMs: 1000, upstream: "http://example.com" })).rejects.toThrow(
			"HTTPS or a loopback",
		);
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

	describe("upstream proxy", () => {
		const post = (loopback: ClaudeCodeLoopback) =>
			fetch(`${loopback.baseUrl}/v1/messages`, { method: "POST", body: "{}" });

		it("sends the upstream request through HTTP_PROXY", async () => {
			const upstream = await fixtureUpstream();
			const proxy = await fakeProxy();
			setProxyEnv(proxy.url);
			const loopback = await open(upstream.url);
			expect(await (await post(loopback)).text()).toBe("via proxy");
			expect(proxy.seen).toEqual([`POST ${upstream.url}/v1/messages`]);
			expect(upstream.requests).toEqual([]);
		});

		it("tunnels HTTPS upstreams through HTTPS_PROXY with CONNECT", async () => {
			const proxy = await fakeProxy();
			setProxyEnv(proxy.url);
			const loopback = await open("https://api.example.test");
			await post(loopback).catch(() => {});
			await expect(loopback.response).rejects.toThrow();
			expect(proxy.seen).toEqual(["CONNECT api.example.test:443"]);
		});

		it("skips the proxy for hosts listed in NO_PROXY", async () => {
			const upstream = await fixtureUpstream();
			const proxy = await fakeProxy();
			setProxyEnv(proxy.url, "127.0.0.1");
			const loopback = await open(upstream.url);
			expect(await (await post(loopback)).text()).toBe("event: ping\ndata: {}\n\n");
			expect(proxy.seen).toEqual([]);
			expect(upstream.requests).toHaveLength(1);
		});
	});
});
