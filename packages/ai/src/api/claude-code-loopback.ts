import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";

/** A lunR tool as Claude Code's MCP client sees it. */
export interface ClaudeCodeTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const MAX_MCP_BODY = 1024 * 1024;

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
 * Loopback MCP endpoint that lists lunR's tools so Claude Code accepts their `tool_use` blocks. Calls are
 * always refused; lunR runs tools itself. Claude Code sends its Messages request straight to Anthropic,
 * so nothing here ever sees its sign-in.
 *
 * The URL carries a random path prefix; keep it off command lines (write it to a private config file).
 * The Origin check keeps web pages out.
 */
export class ClaudeCodeLoopback {
	readonly mcpUrl: string;

	private readonly server: Server;
	private readonly prefix: string;
	private readonly tools: readonly ClaudeCodeTool[];
	private closed = false;

	private constructor(server: Server, port: number, prefix: string, tools: readonly ClaudeCodeTool[]) {
		this.server = server;
		this.prefix = prefix;
		this.tools = tools;
		this.mcpUrl = `http://127.0.0.1:${port}${prefix}/mcp`;
		server.on("request", (req, res) => this.handle(req, res));
	}

	static async open(tools: readonly ClaudeCodeTool[] = []): Promise<ClaudeCodeLoopback> {
		const server = createServer();
		const port = await listenOnLoopback(server);
		return new ClaudeCodeLoopback(server, port, `/${randomBytes(32).toString("base64url")}`, tools);
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

/**
 * Base URL for Claude Code runs that must never send a model request, such as setup's model discovery.
 * Each connection is counted and dropped before a single byte is read, so a request that should not
 * happen fails on the spot and its credentials are never received.
 */
export class ClaudeCodeTripwire {
	private connections = 0;
	private port = 0;
	private readonly server: TcpServer = createTcpServer((socket) => {
		this.connections++;
		socket.destroy();
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

	/** Whether Claude Code tried to send a request. */
	get tripped(): boolean {
		return this.connections > 0;
	}

	close(): void {
		this.server.close();
	}
}
