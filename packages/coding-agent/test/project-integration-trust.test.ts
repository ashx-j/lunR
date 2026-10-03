import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPromptsWithModel } from "../src/builtin-extensions/pi-prompt-template-model/prompt-loader.ts";
import { getSessionsDir } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { getPromptResources } from "../src/core/prompt-resource-bridge.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { getSessionRetentionTargets } from "../src/core/session-startup-settings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { hasTrustRequiringProjectResources } from "../src/core/trust-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;
function write(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "lunr-project-trust-"));
	cwd = join(root, "project");
	agentDir = join(root, "profile");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("project integration trust", () => {
	it.each([".mcp.json", ".lunr/mcp.json", ".pi/mcp.json", ".vscode/mcp.json", ".pi-lsp.json"])(
		"requires a decision for integration-only project %s",
		(path) => {
			write(join(cwd, path), {});
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		},
	);

	it.each([true, false])(
		"filters project MCP files and user-config VS Code imports with trust=%s",
		async (trusted) => {
			write(join(agentDir, "mcp.json"), {
				mcpServers: { global: { command: "inert-global" } },
				imports: ["vscode"],
			});
			write(join(cwd, ".mcp.json"), { mcpServers: { shared: { command: "inert-project" } } });
			write(join(cwd, ".pi/mcp.json"), { mcpServers: { legacy: { command: "inert-legacy" } } });
			write(join(cwd, ".vscode/mcp.json"), { mcpServers: { imported: { command: "inert-imported" } } });
			const { loadMcpConfig } = await import("../src/builtin-extensions/pi-mcp-adapter/config.ts");
			expect(Object.keys(loadMcpConfig(undefined, cwd, trusted).mcpServers).sort()).toEqual(
				trusted ? ["global", "imported", "legacy", "shared"] : ["global"],
			);
			write(join(cwd, ".lunr/mcp.json"), { mcpServers: { preferred: { command: "inert-lunr" } } });
			expect(Object.keys(loadMcpConfig(undefined, cwd, trusted).mcpServers).sort()).toEqual(
				trusted ? ["global", "imported", "preferred", "shared"] : ["global"],
			);
			const override = join(cwd, "explicit.json");
			write(override, { mcpServers: { explicit: { command: "inert-cli" } } });
			expect(loadMcpConfig(override, cwd, false).mcpServers).toEqual({ explicit: { command: "inert-cli" } });
		},
	);

	it.each([true, false])("fresh MCP cache connects only approved sources with trust=%s", async (trusted) => {
		write(join(agentDir, "mcp.json"), { mcpServers: { global: { command: "inert-global" } } });
		write(join(cwd, ".mcp.json"), { mcpServers: { project: { command: "inert-project" } } });
		const connect = vi.fn(async () => ({ status: "needs-auth" }));
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/server-manager.ts", () => ({
			McpServerManager: class {
				connect = connect;
				setDefaultRequestTimeoutMs() {}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/lifecycle.ts", () => ({
			McpLifecycleManager: class {
				setGlobalIdleTimeout() {}
				registerServer() {}
				markKeepAlive() {}
				setReconnectCallback() {}
				setIdleShutdownCallback() {}
				startHealthChecks() {}
			},
		}));
		const { initializeMcp } = await import("../src/builtin-extensions/pi-mcp-adapter/init.ts");
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const state = await initializeMcp(
				{ getFlag: () => undefined } as unknown as ExtensionAPI,
				{
					cwd,
					hasUI: false,
					isProjectTrusted: () => trusted,
				} as unknown as ExtensionContext,
			);
			expect(Object.keys(state.config.mcpServers).sort()).toEqual(trusted ? ["global", "project"] : ["global"]);
			expect(connect.mock.calls.length).toBe(trusted ? 2 : 1);
		} finally {
			errors.mockRestore();
			vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/server-manager.ts");
			vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/lifecycle.ts");
			vi.resetModules();
		}
	});

	it.each([true, false])("prevents denied deterministic prompt substitution with trust=%s", async (trusted) => {
		write(join(agentDir, "prompts/build.md"), "---\nmodel: openai/gpt-6-sol\n---\nGlobal prompt");
		write(
			join(cwd, ".lunr/prompts/build.md"),
			"---\ndeterministic:\n  run: inert-project-command\n---\nProject command",
		);
		write(join(cwd, ".lunr/settings.json"), { prompts: ["../other"] });
		write(join(cwd, "other/configured.md"), "---\nmodel: openai/gpt-6-sol\n---\nConfigured project prompt");
		const events = createEventBus();
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			eventBus: events,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }),
			noExtensions: true,
		});
		await loader.reload();
		const result = loadPromptsWithModel(cwd, false, getPromptResources(events));
		expect(result.prompts.get("build")?.source).toBe(trusted ? "project" : "user");
		expect(Boolean(result.prompts.get("build")?.deterministic)).toBe(trusted);
		expect(result.prompts.has("configured")).toBe(trusted);
	});

	it("discovery disable keeps explicit CLI prompts and independent runtime resources", async () => {
		write(join(agentDir, "prompts/global.md"), "---\nmodel: openai/gpt-6-sol\n---\nGlobal");
		write(join(cwd, ".lunr/prompts/project.md"), "---\nmodel: openai/gpt-6-sol\n---\nProject");
		const explicit = join(cwd, "explicit.md");
		write(explicit, "---\ndeterministic:\n  run: inert-explicit-command\n---\nExplicit");
		const disabledEvents = createEventBus();
		const enabledEvents = createEventBus();
		const disabled = new DefaultResourceLoader({
			cwd,
			agentDir,
			eventBus: disabledEvents,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
			noExtensions: true,
			noPromptTemplates: true,
			additionalPromptTemplatePaths: [explicit],
		});
		const enabled = new DefaultResourceLoader({
			cwd,
			agentDir,
			eventBus: enabledEvents,
			settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
			noExtensions: true,
		});
		await disabled.reload();
		await enabled.reload();
		expect([...loadPromptsWithModel(cwd, false, getPromptResources(disabledEvents)).prompts.keys()]).toEqual([
			"explicit",
		]);
		expect([...loadPromptsWithModel(cwd, false, getPromptResources(enabledEvents)).prompts.keys()].sort()).toEqual([
			"global",
			"project",
		]);
	});

	it.each([true, false])(
		"keeps global maintenance separate from project paths and retention with trust=%s",
		(trusted) => {
			const custom = join(root, "project-sessions");
			write(join(agentDir, "settings.json"), { sessionRetentionDays: 30 });
			write(join(cwd, ".lunr/settings.json"), { sessionRetentionDays: 1, sessionDir: custom });
			const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const runtime = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
			expect(global.getSessionDir()).toBeUndefined();
			expect(runtime.getSessionDir()).toBe(trusted ? custom : undefined);
			const prune = vi.fn();
			for (const target of getSessionRetentionTargets(global, runtime)) prune(target.directory, target.days);
			expect(prune.mock.calls).toEqual(
				trusted
					? [
							[getSessionsDir(), 30],
							[custom, 1],
						]
					: [[getSessionsDir(), 30]],
			);
			expect(getSessionRetentionTargets(global, runtime, getSessionsDir())).toEqual([
				{ directory: getSessionsDir(), days: 30 },
			]);
		},
	);
});
