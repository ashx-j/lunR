import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deterministicStep from "../src/builtin-extensions/pi-prompt-template-model/deterministic-step.ts";
import promptModelExtension from "../src/builtin-extensions/pi-prompt-template-model/index.ts";
import { loadPromptsWithModel } from "../src/builtin-extensions/pi-prompt-template-model/prompt-loader.ts";
import { createToolManager } from "../src/builtin-extensions/pi-prompt-template-model/tool-manager.ts";
import {
	discoverPromptWorkflows,
	registerPromptWorkflowCommands,
} from "../src/builtin-extensions/pi-subagents/src/slash/prompt-workflows.ts";
import type { ExtensionCommandContext } from "../src/core/extensions/types.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

let profile: string;
let harness: Harness | undefined;

beforeEach(() => {
	profile = mkdtempSync(join(tmpdir(), "lunr-prompt-contracts-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", profile);
});

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(profile, { recursive: true, force: true });
});

describe("builtin prompt command routing", () => {
	it("resolves both chain engines by their advertised names alongside third-party duplicates", async () => {
		const run = vi.fn();
		const thirdParty = vi.fn();
		harness = await createHarnessWithExtensions({
			extensionFactories: [
				promptModelExtension,
				(pi) => registerPromptWorkflowCommands({ pi, run }),
				(pi) => pi.registerCommand("shared", { handler: async () => thirdParty("first") }),
				(pi) => pi.registerCommand("shared", { handler: async () => thirdParty("second") }),
			],
		});
		const runner = harness.session.extensionRunner!;
		expect(runner.getCommand("chain-prompts")?.description).toContain("prompt templates");
		expect(runner.getCommand("chain-workflows")?.description).toContain("native subagent chain");
		expect(runner.getRegisteredCommands().map((command) => command.invocationName)).toEqual([
			"chain-prompts",
			"prompt-tool",
			"prompt-workflow",
			"chain-workflows",
			"shared:1",
			"shared:2",
		]);

		const promptsDir = join(harness.tempDir, ".lunr", "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "analyze.md"), "---\ntier: light\npermissions: read-only\n---\nAnalyze $1");
		writeFileSync(join(promptsDir, "fix.md"), "---\ntier: standard\n---\nFix $1 after {previous}");
		await harness.session.prompt("/chain-workflows analyze -> fix -- auth --foreground");
		expect(run).toHaveBeenCalledWith(
			{
				chain: [
					{ task: "Analyze auth", description: "analyze", permissions: "read-only", tier: "light" },
					{ task: "Fix auth after {previous}", description: "fix", permissions: "full", tier: "standard" },
				],
				task: "auth",
				clarify: false,
				async: false,
			},
			expect.objectContaining({ cwd: harness.tempDir }),
		);
		await harness.session.prompt("/chain-prompts");
		expect(run).toHaveBeenCalledTimes(1);
		await harness.session.prompt("/shared:1");
		await harness.session.prompt("/shared:2");
		expect(thirdParty.mock.calls).toEqual([["first"], ["second"]]);
		expect(runner.getCommand("shared")).toBeUndefined();
		expect(harness.faux.callCount).toBe(0);
	});

	it("routes /chain-prompts through template execution with the native engine also loaded", async () => {
		const execute = vi
			.spyOn(deterministicStep, "runDeterministicStep")
			.mockImplementation(async (_prompt, step, cwd) => ({
				execution: step.execution,
				cwd,
				nonInteractive: true,
				exitCode: 0,
				stdout: "",
				stdoutTotalChars: 0,
				stdoutTotalLines: 0,
				stdoutTruncated: false,
				stderr: "",
				stderrTotalChars: 0,
				stderrTotalLines: 0,
				stderrTruncated: false,
				durationMs: 0,
				timedOut: false,
			}));
		const promptsDir = join(profile, "prompts");
		mkdirSync(promptsDir);
		for (const name of ["analyze", "fix"]) {
			writeFileSync(join(promptsDir, `${name}.md`), `---\nrun: inert-${name}\nhandoff: never\n---\nTemplate body`);
		}
		const run = vi.fn();
		harness = await createHarnessWithExtensions({
			extensionFactories: [promptModelExtension, (pi) => registerPromptWorkflowCommands({ pi, run })],
		});
		await harness.session.extensionRunner!.emit({ type: "session_start", reason: "startup" });
		await harness.session.prompt("/chain-prompts analyze -> fix");
		expect(execute.mock.calls.map(([prompt]) => prompt.filePath)).toEqual([
			join(promptsDir, "analyze.md"),
			join(promptsDir, "fix.md"),
		]);
		expect(run).not.toHaveBeenCalled();
		expect(harness.faux.callCount).toBe(0);
	});

	it("reserves both chain commands against native workflow filenames", () => {
		const promptsDir = join(profile, "prompts");
		mkdirSync(promptsDir);
		for (const name of ["chain-prompts", "chain-workflows"]) {
			writeFileSync(join(promptsDir, `${name}.md`), "---\ntier: light\n---\nReserved");
		}
		expect(discoverPromptWorkflows(profile).map((workflow) => workflow.name)).not.toContain("chain-workflows");
		expect(discoverPromptWorkflows(profile).map((workflow) => workflow.name)).not.toContain("chain-prompts");
	});

	it("keeps template discovery from replacing the native workflow commands", () => {
		const promptsDir = join(profile, "prompts");
		mkdirSync(promptsDir);
		for (const name of ["chain-workflows", "prompt-workflow", "allowed-template"]) {
			writeFileSync(join(promptsDir, `${name}.md`), "---\nmodel: faux/faux-1\n---\nTemplate body");
		}
		const result = loadPromptsWithModel(profile);
		expect([...result.prompts.keys()]).toEqual(["allowed-template"]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"reserved-command-name",
			"reserved-command-name",
		]);
	});
});

describe("run-prompt tool results", () => {
	async function setup(options: { enabled?: boolean; active?: boolean; context?: boolean; commands: string[] }) {
		writeFileSync(
			join(profile, "prompt-template-model.json"),
			JSON.stringify({ toolEnabled: options.enabled ?? true }),
		);
		let storedCtx: ExtensionCommandContext | null = null;
		let manager: ReturnType<typeof createToolManager> | undefined;
		const executeCommand = vi.fn();
		harness = await createHarnessWithExtensions({
			responses: [
				{ toolCalls: options.commands.map((command) => ({ name: "run-prompt", args: { command } })) },
				"done",
			],
			extensionFactories: [
				(pi) => {
					manager = createToolManager(pi, {
						isActive: () => options.active ?? false,
						getStoredCtx: () => storedCtx,
						setStoredCtx: (ctx) => {
							storedCtx = ctx;
						},
						executeCommand,
					});
					manager.ensureRegistered();
				},
			],
		});
		if (options.context !== false) storedCtx = harness.session.extensionRunner!.createCommandContext();
		await harness.session.prompt("Execute the requested template.");
		return { manager: manager!, executeCommand, harness };
	}

	it.each([
		{ name: "disabled", enabled: false, message: "run-prompt tool is disabled" },
		{ name: "active", active: true, message: "A prompt command is already running" },
		{ name: "missing context", context: false, message: "No command context" },
		{ name: "empty command", command: "   ", message: "No command specified" },
	])("reports $name rejection to the model and tool UI as an error", async ({ message, ...options }) => {
		const { harness, manager } = await setup({ ...options, commands: [options.command ?? "analyze"] });
		const result = harness.session.messages.find((message) => message.role === "toolResult");
		expect(result).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining(message) }],
		});
		expect(harness.eventsOfType("tool_execution_end")).toEqual([expect.objectContaining({ isError: true })]);
		expect(harness.faux.contexts[1].messages).toContainEqual(
			expect.objectContaining({ role: "toolResult", isError: true }),
		);
		expect(manager.hasQueuedCommand()).toBe(false);
	});

	it("keeps the first deferred command and reports a duplicate queue request as an error", async () => {
		const { harness, manager, executeCommand } = await setup({ commands: ["  analyze  ", "fix"] });
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toMatchObject([
			{ isError: false, content: [{ text: 'Prompt command queued: "analyze". Will execute when this turn ends.' }] },
			{ isError: true, content: [{ text: "A prompt command is already queued. Wait for it to execute." }] },
		]);
		expect(executeCommand).not.toHaveBeenCalled();
		const restore = vi.fn();
		await manager.processQueue(harness.session.extensionRunner!.createContext(), restore);
		expect(restore).toHaveBeenCalledOnce();
		expect(executeCommand).toHaveBeenCalledWith("analyze", expect.objectContaining({ cwd: harness.tempDir }));
		expect(manager.hasQueuedCommand()).toBe(false);
	});

	it("describes deferred acceptance and rejection in the enabled tool contract", async () => {
		const { harness } = await setup({ commands: ["chain-prompts analyze -> fix --chain-context"] });
		const definition = harness.session
			.extensionRunner!.getAllRegisteredTools()
			.find((tool) => tool.definition.name === "run-prompt")!.definition;
		expect(definition.description).toContain("A queued result confirms acceptance, not completion");
		expect(definition.description).toContain("Rejected requests fail without changing the queue");
		expect({
			name: definition.name,
			description: definition.description,
			promptSnippet: definition.promptSnippet,
			parameters: JSON.parse(JSON.stringify(definition.parameters)),
		}).toMatchSnapshot();
	});
});
