import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lunrSettingsTools, { DETAILED_SETTINGS_TOOL_NAMES } from "../src/builtin-extensions/lunr-settings-tools.ts";
import simpleMemory from "../src/builtin-extensions/simple-pi-memory.ts";
import { MEMORY_CAP_BRIDGE_SYMBOL, registerMemoryCapBridge } from "../src/core/memory-cap.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { bindRuntimeBridges } from "../src/core/runtime-bridges.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getSettingsToolsBridge, registerSettingsToolsBridge, SETTINGS_TOOLS_BRIDGE_SYMBOL } from "../src/core/settings-tools-bridge.ts";

describe("AgentSession dynamic tool registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[MEMORY_CAP_BRIDGE_SYMBOL];
		delete (globalThis as Record<symbol, unknown>)[SETTINGS_TOOLS_BRIDGE_SYMBOL];
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("starts with settings_load and injects exactly four narrow tools into the live runtime", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		registerSettingsToolsBridge(settingsManager);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [lunrSettingsTools],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		const settingsNames = () =>
			session
				.getAllTools()
				.map((tool) => tool.name)
				.filter((name) => name.startsWith("settings_"));
		expect(settingsNames()).toMatchInlineSnapshot(`
			[
			  "settings_load",
			]
		`);
		expect(session.getActiveToolNames().filter((name) => name.startsWith("settings_"))).toEqual(["settings_load"]);

		const load = session.getToolDefinition("settings_load")!;
		const result = await load.execute("settings-call", {}, undefined, undefined, {} as never);
		expect(result.details).toMatchObject({ activated: [...DETAILED_SETTINGS_TOOL_NAMES], alreadyLoaded: false });
		expect(settingsNames()).toMatchInlineSnapshot(`
			[
			  "settings_load",
			  "settings_model_tiers",
			  "settings_subscriptions",
			  "settings_rollback",
			  "settings_session_retention",
			]
		`);
		expect(session.getActiveToolNames().filter((name) => name.startsWith("settings_"))).toEqual(settingsNames());

		const schemas = session
			.getAllTools()
			.filter((tool) => tool.name.startsWith("settings_"))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				required: (tool.parameters as { required?: string[] }).required ?? [],
				properties: Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
			}));
		expect(schemas).toMatchInlineSnapshot(`
			[
			  {
			    "description": "Load four narrow agent-managed settings tools for model tiers, subscription management, rollback, and session retention. Call only when the task requires inspecting or changing those settings.",
			    "name": "settings_load",
			    "properties": [],
			    "required": [],
			  },
			  {
			    "description": "Read or partially update light, standard, and heavy subagent model routes and their thinking levels. Models use provider/model ids. Omitted fields are unchanged.",
			    "name": "settings_model_tiers",
			    "properties": [
			      "enabled",
			      "light",
			      "standard",
			      "heavy",
			      "lightThinking",
			      "standardThinking",
			      "heavyThinking",
			    ],
			    "required": [],
			  },
			  {
			    "description": "Read or update automatic management of multiple stored provider subscriptions. Omit enabled to read without changing it.",
			    "name": "settings_subscriptions",
			    "properties": [
			      "enabled",
			    ],
			    "required": [],
			  },
			  {
			    "description": "Read or partially update rollback behavior: enabled, retained turns, capture strategy, and scope. Omitted fields are unchanged. Auto permission mode force-enables rollback for its current session.",
			    "name": "settings_rollback",
			    "properties": [
			      "enabled",
			      "turns",
			      "capture",
			      "scope",
			    ],
			    "required": [],
			  },
			  {
			    "description": "Read or update how many days saved sessions are retained. Set days to 0 to keep sessions forever. Cleanup applies on a later launch, not retroactively in this turn.",
			    "name": "settings_session_retention",
			    "properties": [
			      "days",
			    ],
			    "required": [],
			  },
			]
		`);
		expect(
			Object.fromEntries(settingsNames().map((name) => [name, session.systemPrompt.includes(name)])),
		).toMatchInlineSnapshot(`
				{
				  "settings_load": false,
				  "settings_model_tiers": false,
				  "settings_rollback": false,
				  "settings_session_retention": false,
				  "settings_subscriptions": false,
				}
			`);

		const tiers = session.getToolDefinition("settings_model_tiers")!;
		await tiers.execute(
			"tier-call",
			{ enabled: true, light: "xai/grok-4", lightThinking: "high" },
			undefined,
			undefined,
			{} as never,
		);
		expect(settingsManager.getModelTiers()).toMatchObject({
			enabled: true,
			light: "xai/grok-4",
			lightThinking: "high",
		});
		const second = await load.execute("settings-call-2", {}, undefined, undefined, {} as never);
		expect(second.details).toMatchObject({ alreadyLoaded: true });
		expect(settingsNames()).toHaveLength(5);
		session.dispose();
	});

	it("headless bindRuntimeBridges activates settings tools without a prior registerSettingsToolsBridge call", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		expect(getSettingsToolsBridge()).toBeUndefined();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [lunrSettingsTools],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		bindRuntimeBridges({
			session,
			services: {
				settingsManager,
				modelRuntime: session.modelRuntime,
			},
		} as Parameters<typeof bindRuntimeBridges>[0]);
		expect(getSettingsToolsBridge()).toBeDefined();
		await session.bindExtensions({});
		const load = session.getToolDefinition("settings_load")!;
		await load.execute("settings-call", {}, undefined, undefined, {} as never);
		const rollback = session.getToolDefinition("settings_rollback")!;
		const result = await rollback.execute("rollback-call", {}, undefined, undefined, {} as never);
		expect(result.details).toEqual(
			expect.objectContaining({
				enabled: expect.any(Boolean),
				turns: expect.any(Number),
			}),
		);
		session.dispose();
	});

	it("removes and restores memory tools when agent memory is toggled", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		registerMemoryCapBridge(settingsManager);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [simpleMemory],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		const memoryTools = ["memory_add", "memory_remove", "memory_load"];
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(memoryTools));
		expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(memoryTools));

		settingsManager.setMemoryEnabled(false);
		session.refreshToolRegistry();
		expect(session.getActiveToolNames()).not.toEqual(expect.arrayContaining(memoryTools));
		expect(session.getAllTools().map((tool) => tool.name)).not.toEqual(expect.arrayContaining(memoryTools));

		settingsManager.setMemoryEnabled(true);
		session.refreshToolRegistry();
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(memoryTools));
		session.dispose();
	});

	it("refreshes tool registry when tools are registered after initialization", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "dynamic_tool",
							label: "Dynamic Tool",
							description: "Tool registered from session_start",
							promptSnippet: "Run dynamic test behavior",
							promptGuidelines: ["Use dynamic_tool when the user asks for dynamic behavior tests."],
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("dynamic_tool");

		await session.bindExtensions({});

		const allTools = session.getAllTools();
		const dynamicTool = allTools.find((tool) => tool.name === "dynamic_tool");
		const readTool = allTools.find((tool) => tool.name === "read");

		expect(allTools.map((tool) => tool.name)).toContain("dynamic_tool");
		expect(dynamicTool?.promptGuidelines).toEqual([
			"Use dynamic_tool when the user asks for dynamic behavior tests.",
		]);
		expect(dynamicTool?.sourceInfo).toMatchObject({
			path: "<inline:1>",
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		});
		expect(readTool?.sourceInfo).toMatchObject({
			path: "<builtin:read>",
			source: "builtin",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		expect(session.systemPrompt).not.toContain("Run dynamic test behavior");
		expect(session.systemPrompt).not.toContain("Use dynamic_tool when the user asks for dynamic behavior tests.");

		session.dispose();
	});

	it("returns source metadata for SDK custom tools", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			customTools: [
				{
					name: "sdk_tool",
					label: "SDK Tool",
					description: "Tool registered through createAgentSession",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				},
			],
		});

		const sdkTool = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(sdkTool?.sourceInfo).toMatchObject({
			path: "<sdk:sdk_tool>",
			source: "sdk",
			scope: "temporary",
			origin: "top-level",
		});
		expect(session.getActiveToolNames()).toContain("sdk_tool");

		session.dispose();
	});

	it("keeps custom tools active without duplicating them in the base prompt", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();

		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("session_start", () => {
						pi.registerTool({
							name: "hidden_tool",
							label: "Hidden Tool",
							description: "Description should not appear in available tools",
							parameters: Type.Object({}),
							execute: async () => ({
								content: [{ type: "text", text: "ok" }],
								details: {},
							}),
						});
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("hidden_tool");
		expect(session.getActiveToolNames()).toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("hidden_tool");
		expect(session.systemPrompt).not.toContain("Description should not appear in available tools");

		session.dispose();
	});
});
