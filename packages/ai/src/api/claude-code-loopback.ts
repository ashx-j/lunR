import { randomBytes } from "node:crypto";
import {
	type ClientRequest,
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";

/** A lunR tool as Claude Code's MCP client sees it. */
export interface ClaudeCodeTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** Upstream answer to the single admitted Messages request. */
export interface AdmittedResponse {
	status: number;
	headers: Headers;
	body: ReadableStream<Uint8Array>;
}

// Content-Length stays: the body is forwarded byte for byte.
const DROPPED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"accept-encoding",
	"keep-alive",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "server", "date", "keep-alive"]);
const CONSUMED = JSON.stringify({
	type: "error",
	error: { type: "invalid_request_error", message: "LUNR_MODEL_ADMISSION_CONSUMED" },
});
const MAX_MCP_BODY = 1024 * 1024;

function upstreamUrl(value: string): URL {
	const url = new URL(value);
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Claude Code upstream must be HTTPS or a loopback HTTP fixture");
	}
	return url;
}

/** Copies hop-independent headers; Node already lowercases incoming header names. */
function keptHeaders(headers: IncomingHttpHeaders, dropped: ReadonlySet<string>): Record<string, string | string[]> {
	const kept: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !dropped.has(name)) kept[name] = value;
	}
	return kept;
}

/**
 * Loopback HTTP server that sits between one Claude Code process and Anthropic for one lunR request.
 *
 * - `<baseUrl>/v1/messages`: the first POST goes upstream unchanged and its answer is copied to both
 *   Claude Code and `response`. Later attempts are refused locally, so one lunR turn is exactly one
 *   upstream generation even if Claude Code tries to retry or continue.
 * - `<mcpUrl>`: an inventory-only MCP endpoint listing lunR's tools so Claude Code accepts their
 *   `tool_use` blocks. Calls are always refused; lunR runs tools itself.
 *
 * Request credentials pass through in memory only; nothing is logged or stored. A random path prefix
 * and the Origin check keep other local clients and web pages out.
 */
export class ClaudeCodeLoopback {
	readonly baseUrl: string;
	readonly mcpUrl: string;
	/** Settles with the first admitted request's upstream answer; rejects if forwarding fails first. */
	readonly response: Promise<AdmittedResponse>;
	/** Messages requests refused after the first one. */
	denied = 0;

	private readonly server: Server;
	private readonly prefix: string;
	private readonly upstream: URL;
	private readonly tools: readonly ClaudeCodeTool[];
	private readonly timeoutMs: number;
	private used = false;
	private closed = false;
	private outgoing: ClientRequest | undefined;
	private resolveResponse!: (response: AdmittedResponse) => void;
	private rejectResponse!: (error: Error) => void;

	private constructor(
		server: Server,
		prefix: string,
		upstream: URL,
		tools: readonly ClaudeCodeTool[],
		timeoutMs: number,
	) {
		this.server = server;
		this.prefix = prefix;
		this.upstream = upstream;
		this.tools = tools;
		this.timeoutMs = timeoutMs;
		const address = server.address();
		const port = address && typeof address === "object" ? address.port : 0;
		this.baseUrl = `http://127.0.0.1:${port}${prefix}`;
		this.mcpUrl = `${this.baseUrl}/mcp`;
		this.response = new Promise((resolve, reject) => {
			this.resolveResponse = resolve;
			this.rejectResponse = reject;
		});
		// Callers that never reach the upstream step must not see an unhandled rejection.
		this.response.catch(() => {});
		server.on("request", (req, res) => this.handle(req, res));
	}

	static async open(options: {
		timeoutMs: number;
		tools?: readonly ClaudeCodeTool[];
		upstream?: string;
	}): Promise<ClaudeCodeLoopback> {
		const upstream = upstreamUrl(options.upstream ?? "https://api.anthropic.com");
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		return new ClaudeCodeLoopback(
			server,
			`/${randomBytes(32).toString("base64url")}`,
			upstream,
			options.tools ?? [],
			options.timeoutMs,
		);
	}

	/** Whether Claude Code reached the upstream Messages API. */
	get admitted(): boolean {
		return this.used;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectResponse(new Error("Claude Code relay closed"));
		this.outgoing?.destroy();
		this.server.close();
		this.server.closeAllConnections();
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		// Request targets such as `//` make URL parsing throw; an uncaught throw here would end lunR.
		const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
		if (!url || req.headers.origin) {
			res.writeHead(404).end();
		} else if (url.pathname === `${this.prefix}/mcp`) {
			this.handleMcp(req, res);
		} else if (req.method !== "POST" || url.pathname !== `${this.prefix}/v1/messages`) {
			res.writeHead(404).end();
		} else if (this.closed || this.used) {
			this.denied++;
			res.writeHead(400, { "content-type": "application/json", "content-length": Buffer.byteLength(CONSUMED) });
			res.end(CONSUMED);
		} else {
			this.used = true;
			this.forward(req, res, url.search);
		}
	}

	private forward(req: IncomingMessage, res: ServerResponse, search: string): void {
		const target = new URL(`${this.upstream.pathname.replace(/\/$/, "")}/v1/messages${search}`, this.upstream);
		const send = target.protocol === "https:" ? httpsRequest : httpRequest;
		const fail = (error: Error) => {
			this.rejectResponse(error);
			res.destroy();
		};
		const outgoing = send(target, {
			method: "POST",
			headers: { ...keptHeaders(req.headers, DROPPED_REQUEST_HEADERS), "accept-encoding": "identity" },
		});
		this.outgoing = outgoing;
		req.on("error", fail);
		res.on("error", () => {});
		outgoing.setTimeout(this.timeoutMs, () => outgoing.destroy(new Error("Claude Code upstream request timed out")));
		outgoing.on("error", fail);
		outgoing.on("response", (upstream) => {
			const status = upstream.statusCode ?? 502;
			const forwarded = keptHeaders(upstream.headers, DROPPED_RESPONSE_HEADERS);
			res.writeHead(status, { ...forwarded, connection: "close" });
			const headers = new Headers();
			for (const [name, value] of Object.entries(forwarded)) {
				for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
			}
			let settled = false;
			// A broken connection is reported once by the close handler below.
			upstream.on("error", () => {});
			const body = new ReadableStream<Uint8Array>({
				start: (controller) => {
					upstream.on("data", (chunk: Buffer) => {
						res.write(chunk);
						if (!settled) controller.enqueue(new Uint8Array(chunk));
					});
					upstream.on("end", () => {
						res.end();
						if (settled) return;
						settled = true;
						controller.close();
					});
					upstream.on("close", () => {
						if (upstream.complete || settled) return;
						settled = true;
						controller.error(new Error("Claude Code upstream stream ended early"));
						res.destroy();
					});
				},
				cancel: () => {
					settled = true;
					outgoing.destroy();
				},
			});
			this.resolveResponse({ status, headers, body });
		});
		req.pipe(outgoing);
	}

	private handleMcp(req: IncomingMessage, res: ServerResponse): void {
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" }).end();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_MCP_BODY) req.destroy();
			else chunks.push(chunk);
		});
		req.on("end", () => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				res.writeHead(400).end();
				return;
			}
			const replies = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((message) => this.mcpReply(message) ?? []);
			if (!replies.length) {
				res.writeHead(202).end();
				return;
			}
			const body = JSON.stringify(Array.isArray(parsed) ? replies : replies[0]);
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
		});
	}

	private mcpReply(message: unknown): object | undefined {
		if (!message || typeof message !== "object" || !("method" in message) || !("id" in message)) return undefined;
		const params = "params" in message && message.params && typeof message.params === "object" ? message.params : {};
		const result =
			message.method === "initialize"
				? {
						protocolVersion:
							"protocolVersion" in params && typeof params.protocolVersion === "string"
								? params.protocolVersion
								: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: "lunr-tools", version: "1" },
					}
				: message.method === "tools/list"
					? { tools: this.tools }
					: message.method === "tools/call"
						? { isError: true, content: [{ type: "text", text: "Denied: lunR runs its own tools." }] }
						: {};
		return { jsonrpc: "2.0", id: message.id, result };
	}
}
