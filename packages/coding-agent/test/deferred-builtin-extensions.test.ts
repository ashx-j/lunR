import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFERRED_BUILTIN_EXTENSION_NAMES,
	lightBuiltinExtensions,
	loadAllBuiltinExtensions,
	loadDeferredBuiltinExtensionsResult,
} from "../src/builtin-extensions/index.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("deferred builtin extensions", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (dirs.length > 0) {
			rmSync(dirs.pop()!, { recursive: true, force: true });
		}
	});

	it("keeps MCP / LSP / web-access / intercom / subagents off the light roster", () => {
		const lightNames = lightBuiltinExtensions.map((entry) => ("name" in entry ? entry.name : ""));
		expect(lightNames).toContain("ashxj-tui");
		expect(lightNames).toContain("lunr-local-providers");
		expect(lightNames).toContain("simple-pi-memory");
		expect(lightNames).toContain("lunr-settings-tools");
		expect(lightNames).not.toContain("lunr-behavior");
		for (const name of DEFERRED_BUILTIN_EXTENSION_NAMES) {
			expect(lightNames).not.toContain(name);
		}
		expect(lightNames).not.toContain("pi-ollama-cloud");
		expect(lightNames).not.toContain("narumiruna-pi-goal");
		expect(lightNames).not.toContain("lunr-cron");
	});

	it("keeps goal / cron / ollama-cloud on the full roster", async () => {
		const all = await loadAllBuiltinExtensions();
		const names = all.map((entry) => ("name" in entry ? entry.name : ""));
		expect(names).toContain("pi-ollama-cloud");
		expect(names).toContain("narumiruna-pi-goal");
		expect(names).toContain("lunr-cron");
		expect(names).toContain("pi-mcp-adapter");
	});

	it("loads deferred builtins independently while preserving roster order", async () => {
		const first = vi.fn();
		const third = vi.fn();
		const result = await loadDeferredBuiltinExtensionsResult([
			{ name: "first", load: async () => ({ default: first }) },
			{ name: "broken", load: async () => Promise.reject(new Error("import exploded")) },
			{ name: "third", load: async () => ({ default: third }) },
		]);

		expect(result.extensions.map((entry) => ("name" in entry ? entry.name : ""))).toEqual(["first", "third"]);
		expect(result.failures).toMatchObject([{ name: "broken", error: { message: "import exploded" } }]);
	});

	it("attaches a late inline factory after first bind without restarting earlier extensions", async () => {
		const tempDir = join(tmpdir(), `lunr-deferred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		dirs.push(tempDir);

		const started: string[] = [];
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					{
						name: "early",
						factory: (pi) => {
							pi.on("session_start", () => {
								started.push("early");
							});
						},
					},
				],
			},
		});
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await session.bindExtensions({ mode: "print" });
		expect(started).toEqual(["early"]);

		await session.attachInlineExtensions([
			{
				name: "late",
				factory: (pi) => {
					pi.on("session_start", () => {
						started.push("late");
					});
				},
			},
		]);

		expect(started).toEqual(["early", "late"]);
		expect(session.extensionRunner.getExtensionPaths()).toContain("<inline:late>");
		expect(session.extensionRunner.getExtensionPaths()).toEqual(
			expect.arrayContaining(["<inline:early>", "<inline:late>"]),
		);
		expect(session.extensionRunner.getExtensionPaths().filter((path) => path === "<inline:late>")).toHaveLength(1);

		await session.attachInlineExtensions([
			{
				name: "late",
				factory: (pi) => {
					pi.on("session_start", () => {
						started.push("late-again");
					});
				},
			},
		]);
		expect(started).toEqual(["early", "late"]);
		expect(session.extensionRunner.getExtensionPaths().filter((path) => path === "<inline:late>")).toHaveLength(1);
	});

	it("setRuntimeApiKey can stay cache-only", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
		const started = Date.now();
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: true,
		});
		await runtime.setRuntimeApiKey("xai", "test-key", { allowNetwork: false });
		expect(Date.now() - started).toBeLessThan(2000);
		expect(fetch).not.toHaveBeenCalled();
		expect(runtime.hasRuntimeApiKey("xai")).toBe(true);
		expect(runtime.hasConfiguredAuth("xai")).toBe(true);
	});
});
