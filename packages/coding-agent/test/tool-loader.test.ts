import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import toolLoader, { DEFERRED_TOOL_GROUPS } from "../src/builtin-extensions/lunr-tool-loader.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const DEFERRED = DEFERRED_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => tool.name));
const sonnet = getModel("anthropic", "claude-sonnet-4-5");

/** Stand-ins for every table tool plus one tool that stays loaded, so the loader sees the whole table. */
const standIns: ExtensionFactory = (pi) => {
	for (const name of [...DEFERRED, "always_tool"])
		pi.registerTool({
			name,
			label: name,
			description: `${name} stand-in`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: `${name} ran` }], details: undefined }),
		});
};

/** What one provider request carried. */
interface Request {
	tools: string[];
	deferredTools: string[] | undefined;
	systemPrompt: string | undefined;
	loaderDescription: string | undefined;
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startSession(
	options: {
		model?: Model<Api>;
		tools?: string[];
		excludeTools?: string[];
		deferredToolsEnabled?: boolean;
		sessionManager?: SessionManager;
	} = {},
) {
	const cwd = mkdtempSync(join(tmpdir(), "lunr-tool-loader-"));
	directories.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	if (options.deferredToolsEnabled === false) settingsManager.setDeferredToolsEnabled(false);
	const credentials = AuthStorage.create(join(agentDir, "auth.json"));
	for (const provider of ["anthropic", "openai-codex"])
		await credentials.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [standIns, toolLoader],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: options.model ?? sonnet,
		settingsManager,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		modelRuntime: await ModelRuntime.create({ credentials, modelsPath: join(agentDir, "models.json") }),
		resourceLoader,
		tools: options.tools,
		excludeTools: options.excludeTools,
	});
	await session.bindExtensions({});
	return session;
}

/** Answers each provider request with the next scripted tool calls, then "done", and records every request. */
async function run(session: Awaited<ReturnType<typeof startSession>>, replies: ToolCall[][] = []): Promise<Request[]> {
	const requests: Request[] = [];
	session.agent.streamFn = (_model, context) => {
		requests.push({
			tools: context.tools?.map((tool) => tool.name) ?? [],
			deferredTools: context.deferredTools?.map((tool) => tool.name),
			systemPrompt: context.systemPrompt,
			loaderDescription: context.tools?.find((tool) => tool.name === "load_tools")?.description,
		});
		const calls = replies[requests.length - 1];
		const message = calls ? fauxAssistantMessage(calls, { stopReason: "toolUse" }) : fauxAssistantMessage("done");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message: message as AssistantMessage }),
		);
		return stream;
	};
	await session.prompt("go");
	return requests;
}

const loadCall = (...names: string[]) => fauxToolCall("load_tools", { names });

function toolResults(session: Awaited<ReturnType<typeof startSession>>): ToolResultMessage[] {
	return session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

describe("lunr-tool-loader", () => {
	it("starts the table unloaded, declares it in order and registers load_tools", async () => {
		const session = await startSession();
		const [first] = await run(session);

		expect(first.tools).toEqual(expect.arrayContaining(["always_tool", "load_tools"]));
		expect(first.tools.filter((name) => DEFERRED.includes(name))).toEqual([]);
		expect(first.deferredTools).toEqual(DEFERRED);
		session.dispose();
	});

	it("loads a tool's whole group and records the activation on the result", async () => {
		const session = await startSession();
		const requests = await run(session, [[loadCall("web_search")]]);
		const web = ["web_search", "fetch_content", "get_search_content"];

		expect(requests[1].tools).toEqual(expect.arrayContaining(web));
		expect(toolResults(session)[0]).toMatchObject({
			addedToolNames: web,
			content: [{ type: "text", text: "Loaded tools: web_search, fetch_content, get_search_content." }],
		});
		session.dispose();
	});

	it("records a load only on the load_tools result when another tool runs in the same step", async () => {
		const session = await startSession();
		await run(session, [[fauxToolCall("always_tool", {}), loadCall("cron")]]);

		expect(toolResults(session).map((result) => [result.toolName, result.addedToolNames])).toEqual([
			["always_tool", undefined],
			["load_tools", ["cron"]],
		]);
		session.dispose();
	});

	it("answers an unknown name with the valid names", async () => {
		const session = await startSession();
		await run(session, [[loadCall("nope")]]);
		const [result] = toolResults(session);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("Unknown names: nope. Valid names: subagents, subagent, subagent_wait, web,"),
		});
		session.dispose();
	});

	it("keeps the system prompt and loader description byte-identical while every group loads", async () => {
		const session = await startSession();
		const requests = await run(
			session,
			DEFERRED_TOOL_GROUPS.map((group) => [loadCall(group.name)]),
		);

		expect(requests).toHaveLength(DEFERRED_TOOL_GROUPS.length + 1);
		expect(new Set(requests.map((request) => request.systemPrompt)).size).toBe(1);
		expect(new Set(requests.map((request) => request.loaderDescription)).size).toBe(1);
		expect(requests.at(-1)?.tools).toEqual(expect.arrayContaining(DEFERRED));
		session.dispose();
	});

	it.each([
		["the setting is off", { deferredToolsEnabled: false }],
		["the model has no native loading", { model: getModel("anthropic", "claude-haiku-4-5") }],
		["the model is Codex", { model: getModel("openai-codex", "gpt-5.5") }],
		["the session has a tool allowlist", { tools: [...DEFERRED, "always_tool"] }],
	] as const)("keeps every tool loaded when %s", async (_case, options) => {
		const session = await startSession(options);
		const [first] = await run(session);

		expect(first.tools).toEqual(expect.arrayContaining([...DEFERRED, "always_tool"]));
		expect(first.tools).not.toContain("load_tools");
		expect(first.deferredTools ?? []).toEqual([]);
		session.dispose();
	});

	it("leaves excluded tools out of the catalog", async () => {
		const session = await startSession({ excludeTools: ["cron", "subagent", "subagent_wait"] });
		const [first] = await run(session);

		expect(first.loaderDescription).toContain("\n- web: ");
		expect(first.loaderDescription).not.toMatch(/\n- (cron|subagents): /);
		expect(first.deferredTools).not.toEqual(expect.arrayContaining(["cron"]));
		session.dispose();
	});

	it.each([
		["a cron load", [loadCall("cron")], ["cron"]],
		["a subagent call without a load", [fauxToolCall("subagent", {})], ["subagent", "subagent_wait"]],
	] as const)("restores the groups a resumed branch used: %s", async (_case, calls, restored) => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
		sessionManager.appendMessage({ ...fauxAssistantMessage([...calls], { stopReason: "toolUse" }), timestamp: 2 });
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: calls[0].id,
			toolName: calls[0].name,
			content: [{ type: "text", text: "ok" }],
			...(calls[0].name === "load_tools" ? { addedToolNames: ["cron"] } : {}),
			isError: false,
			timestamp: 3,
		});
		const session = await startSession({ sessionManager });
		const [first] = await run(session);

		expect(first.tools).toEqual(expect.arrayContaining(["load_tools", ...restored]));
		expect(first.tools.filter((name) => DEFERRED.includes(name))).toEqual(restored);
		session.dispose();
	});
});
