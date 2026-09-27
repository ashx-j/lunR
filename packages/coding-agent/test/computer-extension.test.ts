import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "../../agent/src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "../../agent/src/types.ts";
import computerUse from "../src/builtin-extensions/lunr-computer-use.ts";
import {
	COMPUTER_TOOLS,
	computerPolicy,
	computerRefusal,
	computerSettingsChanged,
} from "../src/core/computer-use/policy.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/types.ts";
import { readOnlyModeBlockReason } from "../src/core/plan-mode.ts";

vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: { create: () => ({ getComputerUse: () => true, getComputerForeground: () => true }) },
}));
const setup = vi.hoisted(() => ({ install: vi.fn(), execute: vi.fn(), close: vi.fn(), adapter: vi.fn() }));
vi.mock("../src/core/computer-use/runtime.ts", () => ({ installRuntime: setup.install }));
vi.mock("../src/core/computer-use/adapter.ts", () => ({
	CuaAdapter: class {
		constructor() {
			setup.adapter();
		}
	},
}));
vi.mock("../src/core/computer-use/workflow.ts", () => ({
	ComputerWorkflow: class {
		execute = setup.execute;
		close = setup.close;
	},
}));
const originalPlatform = process.platform;
const originalArch = process.arch;
afterEach(() => {
	vi.unstubAllEnvs();
	setup.install.mockReset();
	setup.execute.mockReset();
	setup.close.mockReset();
	setup.adapter.mockReset();
	Object.defineProperty(process, "platform", { value: originalPlatform });
	Object.defineProperty(process, "arch", { value: originalArch });
});

function fixture(platform = "win32") {
	Object.defineProperty(process, "platform", { value: platform });
	Object.defineProperty(process, "arch", { value: platform === "darwin" ? "arm64" : "x64" });
	vi.stubEnv("PI_SUBAGENT_CHILD", "");
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	let active = ["read"];
	const pi = {
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
			tools.set(tool.name, tool);
			active.push(tool.name);
		},
		on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as ExtensionAPI;
	const ctx = { cwd: ".", model: { input: ["text", "image"] } } as ExtensionContext;
	computerUse(pi);
	return { active: () => active, handlers, tools, commands, ctx };
}

describe("computer extension lifecycle", () => {
	it("keeps setup local and gives the user the exact signed app path for OS grants", async () => {
		const f = fixture("darwin");
		const notify = vi.fn();
		const ctx = {
			...f.ctx,
			mode: "print",
			hasUI: false,
			ui: { notify },
			waitForIdle: vi.fn(),
		} as unknown as ExtensionCommandContext;
		const command = f.commands.get("computer")!;
		await command.handler("setup", ctx);
		expect(setup.install).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("local lunR terminal"), "warning");
		setup.install.mockResolvedValue({ app: "/owned/CuaDriver.app", command: "/owned/cua-driver" });
		await command.handler("setup", { ...ctx, mode: "tui", hasUI: true });
		expect(setup.install).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("/owned/CuaDriver.app"), "info");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Setup has not captured"), "info");
		await f.handlers.get("session_shutdown")?.();
	});
	it("exposes discovery before the first request and disables active tools synchronously", async () => {
		const f = fixture();
		expect([...f.tools.keys()]).toEqual([...COMPUTER_TOOLS]);
		expect(f.tools.get("computer_load")?.description).toContain(
			"computer_end releases the workflow without a prompt",
		);
		expect(f.tools.get("computer_load")?.description).toContain("Read-only permits observation and release only");
		expect(f.tools.get("computer_load")?.description).not.toContain("Manual approves");
		expect(f.tools.get("computer_key")?.description).toContain("post-action image");
		expect(f.tools.get("computer_observe")?.description).toContain("crop");
		expect(f.tools.get("computer_apps")?.description).toContain("Prefer query");
		expect(f.tools.get("computer_apps")?.description).toContain("include_windows=true");
		expect(f.tools.get("computer_apps")?.parameters.properties.include_windows).toMatchObject({ type: "boolean" });
		expect(f.tools.get("computer_hover")?.description).toContain("real pointer");
		expect(f.tools.get("computer_hover")?.parameters.required).toEqual([
			"desktop",
			"foreground",
			"observation",
			"x",
			"y",
		]);
		expect(f.tools.get("computer_apps")?.parameters.properties.query).toMatchObject({
			type: "string",
			minLength: 1,
			maxLength: 240,
		});
		for (const tool of f.tools.values()) {
			expect(tool.description).not.toContain("accessibility element");
			expect(tool.parameters.properties).not.toHaveProperty("element_index");
		}
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", "computer_load"]);
		const loaded = await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		expect(JSON.stringify(loaded)).toContain("copy its image token exactly");
		expect(JSON.stringify(loaded)).toContain("including window focus");
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", ...COMPUTER_TOOLS]);
		computerSettingsChanged({ enabled: false, foreground: true });
		expect(f.active()).toEqual(["read"]);
		computerSettingsChanged({ enabled: true, foreground: false });
		expect(f.active()).toEqual(["read", "computer_load"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("omits desktop hover registration on macOS and unsupported hosts", async () => {
		for (const platform of ["darwin", "linux"]) {
			const f = fixture(platform);
			expect(f.tools.has("computer_hover")).toBe(false);
			await f.handlers.get("session_start")?.({}, f.ctx);
			if (platform === "darwin") {
				await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
				await f.handlers.get("before_agent_start")?.({}, f.ctx);
				expect(f.active()).not.toContain("computer_hover");
			}
			await f.handlers.get("session_shutdown")?.();
		}
	});
	it("treats hover as foreground mutation and blocks it before native initialization", async () => {
		const f = fixture();
		expect(computerPolicy("computer_hover", { desktop: true, foreground: true })).toEqual({
			observation: false,
			foreground: true,
		});
		expect(readOnlyModeBlockReason("computer_hover", { desktop: true, foreground: true })).toBeTruthy();
		expect(
			computerRefusal(
				"computer_hover",
				{ desktop: true, foreground: true },
				{
					enabled: true,
					foreground: true,
					child: true,
					vision: true,
				},
			),
		).toContain("main agents");
		await f.handlers.get("session_start")?.({}, f.ctx);
		computerSettingsChanged({ enabled: true, foreground: false });
		await expect(
			f.tools
				.get("computer_hover")
				?.execute(
					"hover",
					{ desktop: true, foreground: true, observation: "t", x: 1, y: 1 },
					undefined,
					undefined,
					f.ctx,
				),
		).rejects.toThrow("Foreground control is disabled");
		expect(setup.adapter).not.toHaveBeenCalled();
		await f.handlers.get("session_shutdown")?.();
	});
	it("rejects an in-progress tool initialization when settings change", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		const pending = f.tools.get("computer_apps")?.execute("apps", {}, undefined, undefined, f.ctx);
		computerSettingsChanged({ enabled: false, foreground: false });
		await expect(pending).rejects.toThrow("session replaced");
		expect(f.active()).toEqual(["read"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("throws a tool error for a non-image model without initializing the desktop", async () => {
		const f = fixture();
		const ctx = { ...f.ctx, model: { ...f.ctx.model, input: ["text"] } } as ExtensionContext;
		await expect(f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, ctx)).rejects.toThrow(
			"image-capable",
		);
		expect(setup.install).not.toHaveBeenCalled();
		expect(setup.adapter).not.toHaveBeenCalled();
		await expect(f.tools.get("computer_end")?.execute("end", {}, undefined, undefined, ctx)).resolves.toMatchObject({
			content: [{ text: "Desktop workflow released." }],
		});
		await f.handlers.get("session_shutdown")?.();
	});
	it("never reactivates discovery on an unsupported platform", async () => {
		const f = fixture("linux");
		await f.handlers.get("session_start")?.({}, f.ctx);
		computerSettingsChanged({ enabled: true, foreground: true });
		expect(f.active()).toEqual(["read"]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("retains a healthy loaded workflow and error image after recoverable failure", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
		const details = { observation: "fresh", computer: { failed: true, workflow: "ready" } };
		setup.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "input may have taken effect" }, image],
			details,
			isError: true,
		});
		const failed = await f.tools
			.get("computer_click")
			?.execute(
				"click",
				{ desktop: true, foreground: true, observation: "stale", x: 2, y: 2 },
				undefined,
				undefined,
				f.ctx,
			);
		expect(failed).toMatchObject({ content: [{ text: "input may have taken effect" }, image], details });
		expect(setup.close).not.toHaveBeenCalled();
		const override = await f.handlers.get("tool_result")?.({
			toolName: "computer_click",
			details: failed?.details,
			isError: false,
		});
		expect(override).toEqual({ isError: true });
		expect(
			await f.handlers.get("tool_result")?.({ toolName: "read", details: failed?.details, isError: false }),
		).toBeUndefined();
		expect(
			await f.handlers.get("tool_result")?.({
				toolName: "computer_click",
				details: { computer: { failed: false } },
				isError: false,
			}),
		).toBeUndefined();
		setup.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "new image" }, image],
			details: { computer: { failed: false, workflow: "ready" } },
			isError: false,
		});
		await f.tools.get("computer_observe")?.execute("observe", { desktop: true }, undefined, undefined, f.ctx);
		expect(setup.adapter).toHaveBeenCalledTimes(1);
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", ...COMPUTER_TOOLS]);
		await f.handlers.get("session_shutdown")?.();
	});
	it("keeps a recovery image, details, and error flag in the actual agent-loop tool result", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		const image = { type: "image" as const, data: "YQ==", mimeType: "image/png" };
		const details = { observation: "fresh", computer: { failed: true, workflow: "ready" } };
		setup.execute.mockResolvedValue({
			content: [{ type: "text", text: "effect unverified" }, image],
			details,
			isError: true,
		});
		const tool = f.tools.get("computer_click")!;
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [{ ...tool, execute: (id, params, signal, update) => tool.execute(id, params, signal, update, f.ctx) }],
		};
		const model: Model<"openai-responses"> = {
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		let turn = 0;
		const config: AgentLoopConfig = {
			model,
			convertToLlm: (messages) =>
				messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role)) as Message[],
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const override = await f.handlers.get("tool_result")?.({
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args,
					content: result.content,
					details: result.details,
					isError,
				});
				return {
					content: result.content,
					details: result.details,
					...(override as { isError?: boolean } | undefined),
				};
			},
		};
		const stream = agentLoop(
			[{ role: "user", content: "click", timestamp: Date.now() }],
			context,
			config,
			undefined,
			() => {
				const output = new EventStream<AssistantMessageEvent, AssistantMessage>(
					(event) => event.type === "done" || event.type === "error",
					(event) => (event.type === "done" ? event.message : event.error),
				);
				const content: AssistantMessage["content"] =
					turn++ === 0
						? [
								{
									type: "toolCall",
									id: "click-1",
									name: "computer_click",
									arguments: { desktop: true, foreground: true, observation: "prior", x: 1, y: 1 },
								},
							]
						: [{ type: "text", text: "done" }];
				queueMicrotask(() =>
					output.push({
						type: "done",
						reason: content[0].type === "toolCall" ? "toolUse" : "stop",
						message: {
							role: "assistant",
							content,
							api: "openai-responses",
							provider: "openai",
							model: "mock",
							usage,
							stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
							timestamp: Date.now(),
						},
					}),
				);
				return output;
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const recorded = events.filter((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(recorded).toHaveLength(1);
		expect(recorded[0].message).toMatchObject({
			isError: true,
			details,
			content: [{ text: "effect unverified" }, image],
		});
		expect(setup.execute).toHaveBeenCalledTimes(1);
		expect(setup.close).not.toHaveBeenCalled();
		await f.handlers.get("session_shutdown")?.();
	});
	it("discards stopped workflows without replacing the original outcome on failed cleanup", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		setup.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "original outcome" }],
			details: { computer: { failed: true, workflow: "cleanup_unconfirmed" } },
			isError: true,
		});
		setup.close.mockRejectedValueOnce(new Error("cleanup failed"));
		const result = await f.tools.get("computer_click")?.execute("click", {}, undefined, undefined, f.ctx);
		expect(result?.content[0]).toMatchObject({ text: "original outcome" });
		expect(setup.close).toHaveBeenCalledTimes(1);
		setup.execute.mockResolvedValueOnce({
			content: [{ type: "text", text: "new runtime" }],
			details: { computer: { failed: false, workflow: "ready" } },
			isError: false,
		});
		await f.tools.get("computer_apps")?.execute("apps", {}, undefined, undefined, f.ctx);
		expect(setup.adapter).toHaveBeenCalledTimes(2);
		await f.handlers.get("session_shutdown")?.();
	});
	it("cancellation and unexpected workflow errors close the runtime without reloading tools", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		const cancelled = new AbortController();
		cancelled.abort();
		await expect(
			f.tools.get("computer_click")?.execute("cancel", {}, cancelled.signal, undefined, f.ctx),
		).rejects.toThrow();
		expect(setup.adapter).not.toHaveBeenCalled();
		setup.execute.mockRejectedValueOnce(new Error("broken transport"));
		await expect(f.tools.get("computer_click")?.execute("click", {}, undefined, undefined, f.ctx)).rejects.toThrow(
			"broken transport",
		);
		expect(setup.close).toHaveBeenCalledTimes(1);
		await f.handlers.get("before_agent_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", ...COMPUTER_TOOLS]);
		await f.handlers.get("agent_end")?.();
		await f.handlers.get("session_shutdown")?.();
	});
	it("session replacement discards the loaded tool roster", async () => {
		const f = fixture();
		await f.handlers.get("session_start")?.({}, f.ctx);
		await f.tools.get("computer_load")?.execute("load", {}, undefined, undefined, f.ctx);
		await f.handlers.get("session_start")?.({}, f.ctx);
		expect(f.active()).toEqual(["read", "computer_load"]);
		await f.handlers.get("session_shutdown")?.();
	});
});
