import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.ACP_FIXTURE_MCP_PIDS) appendFileSync(process.env.ACP_FIXTURE_MCP_PIDS, `${process.pid}\n`);
const server = new Server({ name: "acp-fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Read the isolated environment marker.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: process.env.ACP_FIXTURE_MCP_MARKER ?? "missing marker" }] }));
await server.connect(new StdioServerTransport());
