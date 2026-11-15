import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";

/** A lunR tool as Claude Code's MCP client sees it. */
export interface ClaudeCodeTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** An MCP `tools/call` result, as lunR's live session hands it back to Claude Code. */
export interface ClaudeCodeToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

/**
 * Answers one held `tools/call` from a live Claude Code process. `id` is Claude Code's `tool_use` id from
 * the call's `_meta`; undefined when the call carried none. Rejecting ends the call without an answer.
 */
export type ClaudeCodeToolHandler = (id: string | undefined) => Promise<ClaudeCodeToolResult>;

const MAX_MCP_BODY = 1024 * 1024;
/** Claude Code saves larger MCP results to a file and sends a preview; lunR's history must keep the text. */
const MAX_RESULT_SIZE_CHARS = 1_000_000_000;
/** An SSE comment on a held tool call, so no idle timeout ends a long lunR tool run. */
const KEEPALIVE_MS = 15_000;

async function listenOnLoopback(server: Server | TcpServer): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	return address && typeof address === "object" ? address.port : 0;
}

/**
 * Loopback MCP endpoint that lists lunR's tools so Claude Code accepts their `tool_use` blocks. lunR runs
 * tools itself: without a tool handler every call is refused; a live session's handler holds each call
 * until lunR's next request brings the result. Claude Code sends its Messages request straight to
 * Anthropic, so nothing here ever sees its sign-in.
 *
 * The URL carries a random path prefix; keep it off command lines (write it to a private config file).
 * The Origin check keeps web pages out.
 */
export class ClaudeCodeLoopback {
	readonly mcpUrl: string;

	private readonly server: Server;
	private readonly prefix: string;
	private readonly tools: readonly ClaudeCodeTool[];
	private readonly onToolCall: ClaudeCodeToolHandler | undefined;
	private closed = false;

	private constructor(
		server: Server,
		port: number,
		prefix: string,
		tools: readonly ClaudeCodeTool[],
		onToolCall: ClaudeCodeToolHandler | undefined,
	) {
		this.server = server;
		this.prefix = prefix;
		this.tools = onToolCall
			? tools.map((tool) => ({ ...tool, _meta: { "anthropic/maxResultSizeChars": MAX_RESULT_SIZE_CHARS } }))
			: tools;
		this.onToolCall = onToolCall;
		this.mcpUrl = `http://127.0.0.1:${port}${prefix}/mcp`;
		server.on("request", (req, res) => this.handle(req, res));
	}

	static async open(
		tools: readonly ClaudeCodeTool[] = [],
		onToolCall?: ClaudeCodeToolHandler,
	): Promise<ClaudeCodeLoopback> {
		const server = createServer();
		const port = await listenOnLoopback(server);
		return new ClaudeCodeLoopback(server, port, `/${randomBytes(32).toString("base64url")}`, tools, onToolCall);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.server.close();
		this.server.closeAllConnections();
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		// Request targets such as `//` make URL parsing throw; an uncaught throw here would end lunR.
		const url = URL.parse(req.url ?? "/", "http://127.0.0.1");
		if (!url || req.headers.origin || url.pathname !== `${this.prefix}/mcp`) {
			res.writeHead(404).end();
		} else if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST" }).end();
		} else {
			this.handleMcp(req, res);
		}
	}

	private handleMcp(req: IncomingMessage, res: ServerResponse): void {
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
			if (this.onToolCall && isToolCall(parsed)) {
				this.holdToolCall(parsed, this.onToolCall, res);
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

	/**
	 * Answers a tools/call as an SSE stream: headers go out at once and comments keep the connection busy
	 * while lunR runs the tool. Closing the connection without an answer makes Claude Code fail the call,
	 * which the live session's failure hook turns into a stop when lunR is gone.
	 */
	private holdToolCall(
		call: { id: string | number; params?: unknown },
		onToolCall: ClaudeCodeToolHandler,
		res: ServerResponse,
	): void {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
		keepalive.unref();
		const meta = isRecord(call.params) && isRecord(call.params._meta) ? call.params._meta : undefined;
		const id = typeof meta?.["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : undefined;
		onToolCall(id).then(
			(result) => {
				clearInterval(keepalive);
				res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: call.id, result })}\n\n`);
			},
			() => {
				clearInterval(keepalive);
				res.destroy();
			},
		);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A single JSON-RPC tools/call request; batches never carry one from Claude Code. */
function isToolCall(message: unknown): message is { id: string | number; params?: unknown } {
	return (
		isRecord(message) &&
		message.method === "tools/call" &&
		(typeof message.id === "string" || typeof message.id === "number")
	);
}

/**
 * Requests that are not model generations: Claude Code's startup warm-up (a bare HEAD with no credentials
 * or body, sent unless a proxy is set) and the token counts `get_context_usage` asks for. Dropping a
 * token count makes Claude Code fall back to estimates; the context window it reports is unaffected.
 */
const HARMLESS = [Buffer.from("HEAD /api/hello "), Buffer.from("POST /v1/messages/count_tokens")];
const HEAD_LENGTH = Math.max(...HARMLESS.map((prefix) => prefix.length));

/**
 * Base URL for Claude Code runs that must never send a model request, such as setup's model discovery.
 * Each connection is dropped as soon as its first bytes show whether it is one of the harmless requests
 * above. Anything else is counted, so a request that should not happen fails on the spot. Only those
 * first bytes are compared; the rest, including any credentials, is discarded uninspected.
 */
export class ClaudeCodeTripwire {
	private requests = 0;
	private port = 0;
	private readonly sockets = new Set<Socket>();
	private readonly server: TcpServer = createTcpServer((socket) => {
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		let head = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			head = Buffer.concat([head, chunk]).subarray(0, HEAD_LENGTH);
			const matches = HARMLESS.filter((prefix) =>
				head.subarray(0, prefix.length).equals(prefix.subarray(0, head.length)),
			);
			// Wait for more bytes while the head is still the start of a harmless prefix but not yet all of one.
			if (matches.length && !matches.some((prefix) => head.length >= prefix.length)) return;
			if (!matches.length) this.requests++;
			socket.destroy();
		});
		// Claude Code may reset first; that is expected here.
		socket.on("error", () => {});
	});

	private constructor() {}

	static async open(): Promise<ClaudeCodeTripwire> {
		const tripwire = new ClaudeCodeTripwire();
		tripwire.port = await listenOnLoopback(tripwire.server);
		return tripwire;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Whether Claude Code sent any request other than its warm-up. */
	get tripped(): boolean {
		return this.requests > 0;
	}

	/** Stops listening and drops connections that never sent enough bytes to judge. */
	close(): void {
		this.server.close();
		for (const socket of this.sockets) socket.destroy();
	}
}
