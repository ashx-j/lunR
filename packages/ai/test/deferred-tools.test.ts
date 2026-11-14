import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";

interface AnthropicToolPayload {
	name: string;
	description?: string;
	defer_loading?: boolean;
	cache_control?: unknown;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	tool_use_id?: string;
	content?: string | Array<{ type: string; tool_name?: string }>;
	source?: {
		type: string;
		media_type: string;
		data: string;
	};
}

interface AnthropicPayload {
	tools?: AnthropicToolPayload[];
	messages: Array<{
		content: string | AnthropicContentBlock[];
	}>;
}

interface OpenAIToolSearchCall {
	type: "tool_search_call";
	call_id?: string | null;
	execution?: string;
	status?: string | null;
}

interface OpenAIToolSearchOutput {
	type: "tool_search_output";
	call_id?: string | null;
	execution?: string;
	status?: string | null;
	tools: Array<{ type: string; name: string; defer_loading?: boolean }>;
}

interface OpenAIPayload {
	tools?: Array<{ name?: string; function?: { name: string } }>;
	input?: Array<OpenAIToolSearchCall | OpenAIToolSearchOutput | { type?: string; call_id?: string }>;
}

interface KimiTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

interface KimiMessage {
	role: string;
	content?: unknown;
	tools?: KimiTool[];
}

interface KimiPayload {
	tools?: KimiTool[];
	messages: KimiMessage[];
}

class PayloadCaptured extends Error {}

function makeTool(name: string): Tool {
	return {
		name,
		description: `The ${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
	};
}

function makeUserMessage(timestamp: number): UserMessage {
	return { role: "user", content: "Hello", timestamp };
}

function makeAssistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(addedToolNames: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "base_tool",
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: 3,
	};
}

function makeContext(tools: Tool[], addedToolNames = ["late_tool"]): Context {
	return {
		messages: [makeUserMessage(1), makeAssistantToolCall(), makeToolResult(addedToolNames), makeUserMessage(4)],
		tools,
	};
}

function makeKimiModel(deferredToolsMode?: "kimi"): Model<"openai-completions"> {
	return {
		id: "deferred-tools-model",
		name: "Deferred Tools Model",
		api: "openai-completions",
		provider: "moonshotai",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: deferredToolsMode ? { deferredToolsMode } : undefined,
	};
}

async function capturePayload<T>(model: Model<Api>, context: Context, apiKey = "fake-key"): Promise<T> {
	let captured: T | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		apiKey,
		onPayload: (payload) => {
			captured = payload as T;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

function findAnthropicToolResultContent(payload: AnthropicPayload): AnthropicContentBlock[] {
	for (const message of payload.messages) {
		if (typeof message.content !== "string" && message.content.some((block) => block.type === "tool_result")) {
			return message.content;
		}
	}
	throw new Error("No tool result in payload");
}

function findAnthropicToolResult(payload: AnthropicPayload): AnthropicContentBlock {
	const result = findAnthropicToolResultContent(payload).find((block) => block.type === "tool_result");
	if (!result) throw new Error("No tool result in payload");
	return result;
}

function openAIToolNames(payload: OpenAIPayload): string[] {
	return (payload.tools ?? []).map((tool) => tool.name ?? tool.function?.name ?? "");
}

function makeCodexToken(): string {
	return `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
}

describe("deferred tools", () => {
	it("loads an Anthropic tool at its tool-result marker", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool", defer_loading: true }]);
		expect(findAnthropicToolResult(payload).content).toEqual([{ type: "tool_reference", tool_name: "late_tool" }]);
	});

	it("preserves tool output as sibling content after emitting references", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [
			{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} },
			{ type: "toolCall", id: "call_2", name: "base_tool", arguments: {} },
		];
		const firstResult = context.messages[2] as ToolResultMessage;
		firstResult.content = [
			{ type: "text", text: "work completed" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		];
		context.messages.splice(3, 0, {
			...makeToolResult([]),
			toolCallId: "call_2",
			content: [{ type: "text", text: "second result" }],
		});

		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(findAnthropicToolResultContent(payload)).toMatchObject([
			{
				type: "tool_result",
				tool_use_id: "call_1",
				content: [{ type: "tool_reference", tool_name: "late_tool" }],
			},
			{ type: "tool_result", tool_use_id: "call_2", content: "second result" },
			{ type: "text", text: "work completed" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
			},
		]);
	});

	it("loads a tool introduced by OpenAI history after switching to Anthropic", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.api = "openai-responses";
		assistant.provider = "openai";
		assistant.model = "gpt-5.4";

		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-8"), context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "late_tool", defer_loading: true }]);
		expect(findAnthropicToolResult(payload).content).toEqual([{ type: "tool_reference", tool_name: "late_tool" }]);
	});

	it("does not resurrect a marked tool missing from Context.tools", async () => {
		const context = makeContext([makeTool("base_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool"]);
		const content = findAnthropicToolResult(payload).content;
		expect(Array.isArray(content) && content.some((block) => block.type === "tool_reference")).toBe(false);
	});

	it("keeps a tool immediate when it was used before its marker", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [{ type: "toolCall", id: "call_1", name: "late_tool", arguments: {} }];
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
	});

	it("keeps API-key tool names case-sensitive when checking prior usage", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("read")], ["read"]);
		const assistant = context.messages[1] as AssistantMessage;
		assistant.content = [{ type: "toolCall", id: "call_1", name: "Read", arguments: {} }];
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([{ name: "base_tool" }, { name: "read", defer_loading: true }]);
		expect(findAnthropicToolResult(payload).content).toEqual([{ type: "tool_reference", tool_name: "read" }]);
	});

	it("does not match differently cased API-key markers to active tools", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("read")], ["Read"]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "read"]);
		expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
		expect(findAnthropicToolResult(payload).content).toBe("done");
	});

	it("preserves distinct API-key tool definitions that differ in case", async () => {
		const context: Context = {
			messages: [makeUserMessage(1)],
			tools: [makeTool("read"), { ...makeTool("Read"), description: "Uppercase definition" }],
		};
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([
			{ name: "read", description: "The read tool" },
			{ name: "Read", description: "Uppercase definition" },
		]);
	});

	it("uses the normal tool list when Anthropic tool references are unsupported", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const models: Model<"anthropic-messages">[] = [
			getModel("anthropic", "claude-haiku-4-5"),
			{ ...getModel("anthropic", "claude-opus-4-6"), id: "claude-sonnet-4-20250514" },
		];

		for (const model of models) {
			const payload = await capturePayload<AnthropicPayload>(model, context);
			expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "late_tool"]);
			expect(payload.tools?.every((tool) => !tool.defer_loading)).toBe(true);
		}
	});

	it("keeps one immediate Anthropic tool when every current tool is marked", async () => {
		const context = makeContext([makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(getModel("anthropic", "claude-opus-4-6"), context);

		expect(payload.tools).toMatchObject([{ name: "late_tool" }]);
		expect(payload.tools?.[0]?.defer_loading).toBeUndefined();
		const content = findAnthropicToolResult(payload).content;
		expect(Array.isArray(content) && content.some((block) => block.type === "tool_reference")).toBe(false);
	});

	it("supports explicit Anthropic compatibility overrides", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-opus-4-6"),
			provider: "anthropic-proxy",
			compat: { supportsToolReferences: true },
		};
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<AnthropicPayload>(model, context);

		expect(payload.tools?.find((tool) => tool.name === "late_tool")?.defer_loading).toBe(true);
	});

	it("serializes Kimi deferred tools as system tool definitions", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<KimiPayload>(makeKimiModel("kimi"), context);

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["base_tool"]);
		const toolResultIndex = payload.messages.findIndex((message) => message.role === "tool");
		const systemToolIndex = payload.messages.findIndex((message) => message.tools !== undefined);
		expect(toolResultIndex).toBeGreaterThanOrEqual(0);
		expect(systemToolIndex).toBeGreaterThan(toolResultIndex);
		expect(payload.messages[systemToolIndex]?.tools?.map((tool) => tool.function.name)).toEqual(["late_tool"]);
	});

	it("emits Kimi deferred schemas after all tool results in a batch", () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool"), makeTool("later_tool")]);
		context.messages.splice(3, 0, {
			...makeToolResult(["later_tool"]),
			toolCallId: "call_2",
		});

		const messages = convertMessages(makeKimiModel("kimi"), context, {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			requiresToolResultName: false,
			requiresAssistantAfterToolResult: false,
			requiresThinkingAsText: false,
			requiresReasoningContentOnAssistantMessages: false,
			thinkingFormat: "openai",
			openRouterRouting: {},
			vercelGatewayRouting: {},
			chatTemplateKwargs: {},
			zaiToolStream: false,
			supportsStrictMode: false,
			cacheControlFormat: undefined,
			sendSessionAffinityHeaders: false,
			deferredToolsMode: "kimi",
			sessionAffinityFormat: "openai",
			supportsLongCacheRetention: false,
		});

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "system", "user"]);
		expect((messages[4] as { tools?: KimiTool[] }).tools?.map((tool) => tool.function.name)).toEqual([
			"late_tool",
			"later_tool",
		]);
	});

	it("leaves OpenAI Completions tools unchanged without Kimi mode", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<KimiPayload>(makeKimiModel(), context);

		expect(payload.tools?.map((tool) => tool.function.name)).toEqual(["base_tool", "late_tool"]);
		expect(payload.messages.some((message) => message.tools !== undefined)).toBe(false);
	});

	it("loads an OpenAI Responses tool through client tool search", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), context);
		const searchCall = payload.input?.find((item): item is OpenAIToolSearchCall => item.type === "tool_search_call");
		const searchOutput = payload.input?.find(
			(item): item is OpenAIToolSearchOutput => item.type === "tool_search_output",
		);

		expect(openAIToolNames(payload)).toEqual(["base_tool"]);
		expect(searchCall).toMatchObject({ execution: "client", status: "completed" });
		expect(searchOutput?.call_id).toBe(searchCall?.call_id);
		expect(searchOutput?.tools).toMatchObject([{ type: "function", name: "late_tool", defer_loading: true }]);
	});

	it.each(["gpt-5.2", "gpt-5.4-nano", "gpt-5.5-pro"] as const)(
		"uses the normal tool list for unsupported OpenAI model %s",
		async (modelId) => {
			const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
			const payload = await capturePayload<OpenAIPayload>(getModel("openai", modelId), context);

			expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
			expect(payload.input?.some((item) => item.type === "tool_search_output")).toBe(false);
		},
	);

	it("uses the normal tool list when OpenAI tool search is explicitly disabled", async () => {
		const model: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "openai-proxy",
			compat: { supportsToolSearch: false },
		};
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(model, context);

		expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
		expect(payload.input?.some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("uses tool search only for supported Codex models", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const supported = await capturePayload<OpenAIPayload>(
			getModel("openai-codex", "gpt-5.5"),
			context,
			makeCodexToken(),
		);
		// An older Codex model without the catalog's tool-search flag.
		const unsupported = await capturePayload<OpenAIPayload>(
			{ ...getModel("openai-codex", "gpt-5.5"), id: "gpt-5.3-codex-spark", compat: undefined },
			context,
			makeCodexToken(),
		);

		expect(openAIToolNames(supported)).toEqual(["base_tool"]);
		expect(supported.input?.some((item) => item.type === "tool_search_output")).toBe(true);
		expect(openAIToolNames(unsupported)).toEqual(["base_tool", "late_tool"]);
		expect(unsupported.input?.some((item) => item.type === "tool_search_output")).toBe(false);
	});

	it("leaves providers without deferred loading unchanged", async () => {
		const context = makeContext([makeTool("base_tool"), makeTool("late_tool")]);
		const payload = await capturePayload<OpenAIPayload>(getModel("groq", "llama-3.3-70b-versatile"), context);
		expect(openAIToolNames(payload)).toEqual(["base_tool", "late_tool"]);
	});

	it("counts definitions marked after the latest usage checkpoint", () => {
		const assistant: AssistantMessage = {
			...makeAssistantToolCall(),
			content: [{ type: "text", text: "done" }],
			usage: {
				input: 50,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const plain = estimateContextTokens({ messages: [assistant, makeUserMessage(4)], tools: [] });
		const lateTool = { ...makeTool("late_tool"), description: "x".repeat(4000) };
		const marked = estimateContextTokens({
			messages: [assistant, makeToolResult(["late_tool"])],
			tools: [lateTool],
		});

		expect(marked.tokens).toBeGreaterThan(plain.tokens + 500);
		expect(marked.trailingTokens).toBeGreaterThan(plain.trailingTokens + 500);
	});
});

describe("declared deferred tools", () => {
	const declared = [makeTool("cron"), makeTool("web_search"), makeTool("fetch_content")];
	const anthropic = getModel("anthropic", "claude-opus-4-6");
	const codex = getModel("openai-codex", "gpt-5.5");

	type Turn = Pick<AssistantMessage, "api" | "provider" | "model">;
	const anthropicTurn: Turn = { api: anthropic.api, provider: anthropic.provider, model: anthropic.id };
	const codexTurn: Turn = { api: codex.api, provider: codex.provider, model: codex.id };

	/** One load_tools call and its result; `names` are the tools that result activated. */
	function load(id: string, names: string[], turn: Turn = anthropicTurn): Message[] {
		return [
			{
				...makeAssistantToolCall(),
				...turn,
				content: [{ type: "toolCall", id, name: "load_tools", arguments: {} }],
			},
			{ ...makeToolResult(names), toolCallId: id, toolName: "load_tools" },
		];
	}

	/** A session context with the loader active, the declared set, and `names` loaded so far. */
	function sessionContext(messages: Message[], loaded: string[] = []): Context {
		return {
			messages,
			tools: [makeTool("base_tool"), makeTool("load_tools"), ...loaded.map(makeTool)],
			deferredTools: declared,
		};
	}

	async function codexPayload(context: Context): Promise<OpenAIPayload> {
		return capturePayload<OpenAIPayload>(codex, context, makeCodexToken());
	}

	function searchPairs(payload: OpenAIPayload): Array<OpenAIToolSearchCall | OpenAIToolSearchOutput> {
		return (payload.input ?? []).filter(
			(item): item is OpenAIToolSearchCall | OpenAIToolSearchOutput =>
				item.type === "tool_search_call" || item.type === "tool_search_output",
		);
	}

	it("advertises the declared set after the immediate tools, in order and without cache markers", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropic, sessionContext([makeUserMessage(1)]));

		expect(payload.tools?.map((tool) => [tool.name, tool.defer_loading])).toEqual([
			["base_tool", undefined],
			["load_tools", undefined],
			["cron", true],
			["web_search", true],
			["fetch_content", true],
		]);
		expect(payload.tools?.filter((tool) => tool.defer_loading).some((tool) => tool.cache_control)).toBe(false);
	});

	it("keeps the tools bytes unchanged when a result loads a declared tool", async () => {
		const before = await capturePayload<AnthropicPayload>(anthropic, sessionContext([makeUserMessage(1)]));
		const after = await capturePayload<AnthropicPayload>(
			anthropic,
			sessionContext([makeUserMessage(1), ...load("call_1", ["cron"]), makeUserMessage(4)], ["cron"]),
		);

		expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
		expect(findAnthropicToolResult(after).content).toEqual([{ type: "tool_reference", tool_name: "cron" }]);
	});

	it("emits a declared tool that is active without a load result once, in the immediate block", async () => {
		const payload = await capturePayload<AnthropicPayload>(anthropic, sessionContext([makeUserMessage(1)], ["cron"]));

		expect(payload.tools?.map((tool) => [tool.name, tool.defer_loading])).toEqual([
			["base_tool", undefined],
			["load_tools", undefined],
			["cron", undefined],
			["web_search", true],
			["fetch_content", true],
		]);
	});

	it("advertises no declared tools to a model without tool references", async () => {
		const payload = await capturePayload<AnthropicPayload>(
			getModel("anthropic", "claude-haiku-4-5"),
			sessionContext([makeUserMessage(1)]),
		);

		expect(payload.tools?.map((tool) => tool.name)).toEqual(["base_tool", "load_tools"]);
	});

	it.each([
		[
			"openai-responses",
			() => capturePayload<OpenAIPayload>(getModel("openai", "gpt-5.4"), sessionContext([makeUserMessage(1)])),
		],
		["openai-codex-responses", () => codexPayload(sessionContext([makeUserMessage(1)]))],
	] as const)("ignores the declared set on %s", async (_api, build) => {
		const payload = await build();

		expect(openAIToolNames(payload)).toEqual(["base_tool", "load_tools"]);
		expect(JSON.stringify(payload.input)).not.toContain("web_search");
	});

	it("loads a 2-tool group on Codex as 1 tool-search pair right after the loader output", async () => {
		const context = sessionContext(
			[makeUserMessage(1), ...load("call_1", ["web_search", "fetch_content"], codexTurn), makeUserMessage(4)],
			["web_search", "fetch_content"],
		);
		const payload = await codexPayload(context);
		const input = payload.input ?? [];
		const output = input.findIndex((item) => item.type === "function_call_output");

		expect(openAIToolNames(payload)).toEqual(["base_tool", "load_tools"]);
		expect(searchPairs(payload)).toHaveLength(2);
		expect(input[output + 1]?.type).toBe("tool_search_call");
		const searchOutput = input[output + 2] as OpenAIToolSearchOutput;
		expect(searchOutput.type).toBe("tool_search_output");
		expect(searchOutput.tools.map((tool) => tool.name)).toEqual(["web_search", "fetch_content"]);
	});

	it("replays earlier Codex input unchanged when the session grows", async () => {
		const history = [makeUserMessage(1), ...load("call_1", ["cron"], codexTurn), makeUserMessage(4)];
		const first = await codexPayload(sessionContext(history, ["cron"]));
		const reply: AssistantMessage = {
			...makeAssistantToolCall(),
			...codexTurn,
			content: [{ type: "text", text: "Loaded." }],
			stopReason: "stop",
			timestamp: 5,
		};
		const second = await codexPayload(sessionContext([...history, reply, makeUserMessage(6)], ["cron"]));

		expect(first.input?.length).toBeGreaterThan(4);
		expect(second.input?.slice(0, first.input?.length)).toEqual(first.input);
	});

	it("adds a second Codex pair for a second load and leaves the first unchanged", async () => {
		const once = [makeUserMessage(1), ...load("call_1", ["web_search", "fetch_content"], codexTurn)];
		const first = await codexPayload(sessionContext([...once, makeUserMessage(4)], ["web_search", "fetch_content"]));
		const second = await codexPayload(
			sessionContext(
				[...once, ...load("call_2", ["cron"], codexTurn), makeUserMessage(4)],
				["web_search", "fetch_content", "cron"],
			),
		);

		expect(searchPairs(second)).toHaveLength(4);
		expect(searchPairs(second).slice(0, 2)).toEqual(searchPairs(first));
	});

	it("replays a load made under Anthropic to Codex with the pair", async () => {
		const payload = await codexPayload(
			sessionContext([makeUserMessage(1), ...load("call_1", ["cron"]), makeUserMessage(4)], ["cron"]),
		);
		const searchOutput = searchPairs(payload).find(
			(item): item is OpenAIToolSearchOutput => item.type === "tool_search_output",
		);

		expect(openAIToolNames(payload)).toEqual(["base_tool", "load_tools"]);
		expect(searchOutput?.tools.map((tool) => tool.name)).toEqual(["cron"]);
	});
});
