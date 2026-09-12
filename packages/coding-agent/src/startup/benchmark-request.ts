import { createHash } from "node:crypto";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "../core/agent-session.ts";
import { markStartupMilestone } from "./startup-milestones.ts";

export function prepareBenchmarkRequest(session: AgentSession): () => Promise<void> {
	session.setSessionName("Startup benchmark");
	const faux = createFauxCore({ provider: "lunr-startup-benchmark" });
	const toolUrl = process.env.PI_STARTUP_BENCHMARK_TOOL_URL;
	if (toolUrl && new URL(toolUrl).hostname !== "127.0.0.1") throw new Error("Startup tool fixture must be local");
	const requestedTool = process.env.PI_STARTUP_BENCHMARK_TOOL;
	let toolCall = toolUrl ? fauxToolCall("fetch_content", { url: toolUrl }) : undefined;
	if (requestedTool === "mcp") toolCall = fauxToolCall("mcp", {});
	else if (requestedTool === "subagent") toolCall = fauxToolCall("subagent", { action: "status", view: "fleet" });
	else if (requestedTool === "lsp") toolCall = fauxToolCall("code_overview", { path: "." });
	else if (requestedTool) throw new Error(`Unknown startup fixture tool: ${requestedTool}`);
	faux.setResponses([
		(context) => {
			markStartupMilestone("first_request_dispatched");
			const expected = session.agent.state.tools.map((tool) => tool.name).sort();
			const actual = context.tools?.map((tool) => tool.name).sort() ?? [];
			if (JSON.stringify(actual) !== JSON.stringify(expected) || !context.systemPrompt) {
				throw new Error("Startup request lost registered tools or instructions");
			}
			const toolSchemaHash = createHash("sha256").update(JSON.stringify(context.tools)).digest("hex");
			process.stderr.write(
				`LUNR_STARTUP_REQUEST ${JSON.stringify({ tools: actual, toolSchemaHash, hasSystemPrompt: true })}\n`,
			);
			return toolCall
				? fauxAssistantMessage([toolCall], { stopReason: "toolUse" })
				: fauxAssistantMessage("startup-request-ok");
		},
		(context) => {
			const result = context.messages.at(-1);
			if (
				result?.role !== "toolResult" ||
				result.isError ||
				result.toolName !== toolCall?.name ||
				(toolUrl && !JSON.stringify(result.content).includes("This local article verifies")) ||
				(requestedTool === "lsp" && !JSON.stringify(result.content).includes("increment"))
			) {
				throw new Error(
					`Startup tool ${toolCall?.name} did not complete its local fixture: ${JSON.stringify(result?.content)}`,
				);
			}
			markStartupMilestone("first_tool_completed");
			return fauxAssistantMessage("startup-request-ok");
		},
	]);
	session.modelRuntime.registerProvider("lunr-startup-benchmark", {
		api: faux.api,
		apiKey: "local-benchmark-only",
		models: faux.models,
		streamSimple: faux.streamSimple,
	});
	session.agent.state.model = faux.getModel();
	return async () => {
		await session.prompt(
			toolCall ? "Use the local startup fixture tool." : "Reply with startup-request-ok. Do not use tools.",
		);
		const last = session.state.messages.at(-1);
		if (last?.role !== "assistant" || last.stopReason === "error" || faux.state.callCount !== (toolCall ? 2 : 1)) {
			const error = new Error(
				`Startup benchmark did not complete its local provider request: ${last?.role === "assistant" ? (last.errorMessage ?? last.stopReason) : last?.role}, calls=${faux.state.callCount}`,
			);
			console.error(error.message);
			throw error;
		}
		markStartupMilestone("first_response_completed");
	};
}
