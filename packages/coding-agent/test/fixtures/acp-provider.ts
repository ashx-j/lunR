import { appendFileSync } from "node:fs";
import {
	type Api,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function scriptedStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		const userIndex = context.messages.findLastIndex((message) => message.role === "user");
		const user = context.messages[userIndex];
		const blocks = user?.role === "user" ? user.content : [];
		const prompt =
			typeof blocks === "string"
				? blocks
				: blocks
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		const images = typeof blocks === "string" ? 0 : blocks.filter((block) => block.type === "image").length;
		const child = prompt.includes("ACP_CHILD_FIXTURE");
		if (child) await new Promise((resolve) => setTimeout(resolve, 3_000));
		const results = context.messages.slice(userIndex + 1).filter((message) => message.role === "toolResult");
		let call: ToolCall | undefined;
		if (prompt === "plan" && results.length < 2) {
			call = {
				type: "toolCall",
				id: `plan-${results.length}-${Date.now()}`,
				name: results.length === 0 ? "present_plan" : "write",
				arguments:
					results.length === 0
						? { summary: "write the approved fixture plan" }
						: { path: "planned.txt", content: "plan approved\n" },
			};
		} else if (prompt === "schedule" && results.length === 0) {
			call = {
				type: "toolCall",
				id: `schedule-${Date.now()}`,
				name: "subagent",
				arguments: { action: "schedule-list" },
			};
		} else if (prompt === "delegate" && results.length === 0) {
			call = {
				type: "toolCall",
				id: `child-${Date.now()}`,
				name: "subagent",
				arguments: {
					task: "ACP_CHILD_FIXTURE: return native child completed",
					description: "fixture child",
					model: "acp-fixture/test",
					thinking: "off",
					permissions: "read-only",
					async: true,
				},
			};
		} else if (prompt.startsWith("write ") && results.length === 0) {
			call = {
				type: "toolCall",
				id: `write-${Date.now()}`,
				name: "write",
				arguments: { path: prompt.slice(6).trim(), content: "written by fixture\n" },
			};
		} else if (prompt === "mcp" && results.length < 2) {
			call = {
				type: "toolCall",
				id: `mcp-${results.length}-${Date.now()}`,
				name: "mcp",
				arguments: results.length === 0 ? { connect: "host" } : { tool: "host_echo", args: "{}" },
			};
		}
		const resultText = results
			.flatMap((result) => result.content.filter((block) => block.type === "text").map((block) => block.text))
			.join("\n");
		const subagent = context.tools?.find((tool) => tool.name === "subagent");
		const profile = {
			tools: context.tools?.map((tool) => tool.name).sort(),
			subagentParameters: Object.keys(subagent?.parameters.properties ?? {}).sort(),
			schedulesAdvertised: subagent?.description.includes("schedule-list"),
			clientScheduling: subagent?.description.includes("Use the client's scheduler."),
			automaticDelegation: context.systemPrompt?.includes("Orchestrate subagents with intent!"),
			directWork: context.systemPrompt?.includes("Work on tasks directly."),
			cronGuidance: context.systemPrompt?.includes("Use cron only"),
		};
		const text =
			prompt === "profile"
				? JSON.stringify(profile)
				: child
					? "native child completed"
					: results.length
						? `tool result: ${resultText}`
						: `fixture response model=${model.id} reasoning=${options?.reasoning ?? "off"} images=${images}`;
		const message: AssistantMessage = {
			...fauxAssistantMessage([], { stopReason: call ? "toolUse" : "stop" }),
			api: model.api,
			provider: model.provider,
			model: model.id,
		};
		stream.push({ type: "start", partial: message });
		if (call) {
			message.content.push(call);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
		} else {
			message.content.push({ type: "thinking", thinking: "fixture reasoning" });
			stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "fixture reasoning", partial: message });
			stream.push({ type: "thinking_end", contentIndex: 0, content: "fixture reasoning", partial: message });
			message.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 1, partial: message });
			stream.push({ type: "text_delta", contentIndex: 1, delta: text.slice(0, 8), partial: message });
			stream.push({ type: "text_delta", contentIndex: 1, delta: text.slice(8), partial: message });
			stream.push({ type: "text_end", contentIndex: 1, content: text, partial: message });
		}
		stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
	});
	return stream;
}

export default function acpProvider(pi: ExtensionAPI): void {
	pi.registerCommand("fixture-reload", {
		description: "reload fixture resources",
		async handler(_args, ctx) {
			await ctx.reload();
		},
	});
	pi.registerCommand("fixture-ask", {
		description: "request fixture input",
		async handler(_args, ctx) {
			const answer = await ctx.ui.input("fixture question");
			pi.sendMessage({
				customType: "fixture-answer",
				content: `fixture answer: ${answer ?? "cancelled"}`,
				display: true,
			});
		},
	});
	pi.registerCommand("fixture-note", {
		description: "publish fixture custom output",
		async handler() {
			pi.sendMessage({ customType: "fixture-hidden", content: "hidden journal context", display: false });
			pi.sendMessage({ customType: "subagent-slash-result", content: "fixture final child report", display: false });
		},
	});
	pi.registerCommand("fixture-new", {
		description: "attempt an extension-owned session switch",
		async handler(_args, ctx) {
			await ctx.newSession();
		},
	});
	pi.registerProvider("acp-fixture", {
		api: "acp-fixture-api",
		baseUrl: "http://localhost:0",
		apiKey: "isolated-fixture-key",
		streamSimple: scriptedStream,
		models: [
			{
				id: "test",
				name: "ACP fixture image model",
				reasoning: true,
				thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
			{
				id: "text-only",
				name: "ACP fixture text model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
	pi.on("session_start", () => {
		if (process.env.ACP_FIXTURE_WORKER_PIDS) appendFileSync(process.env.ACP_FIXTURE_WORKER_PIDS, `${process.pid}\n`);
	});
}
