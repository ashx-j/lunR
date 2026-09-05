import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const terminal = vi.hoisted(() => ({ output: "", starts: 0, input: (_data: string) => {} }));
vi.mock("../src/utils/tools-manager.ts", () => ({ getToolPath: () => undefined, ensureTool: async () => undefined }));
vi.mock("@earendil-works/pi-tui", async (original) => {
	const actual = await original<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		ProcessTerminal: class {
			columns = 100;
			rows = 30;
			start(input: (data: string) => void) {
				terminal.starts++;
				terminal.input = input;
			}
			stop() {}
			write(data: string) {
				terminal.output += data;
			}
			hideCursor() {}
			showCursor() {}
			setTitle() {}
		},
	};
});

import { InteractiveView } from "../src/startup/interactive-view.ts";

let view: InteractiveView | undefined;
let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "lunr-first-paint-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", tempDir);
	vi.stubEnv("PI_OFFLINE", "1");
});
afterEach(() => {
	view?.stop();
	terminal.output = "";
	terminal.starts = 0;
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(tempDir, { recursive: true, force: true });
});
describe("real TUI first paint", () => {
	it("paints the normal rounded chatbox before loading any runtime", async () => {
		view = new InteractiveView();
		view.start();
		await view.waitForFirstFrame();
		expect(terminal.output).toContain("╭");
		expect(terminal.output).toContain("> ");
		expect(terminal.output).not.toContain("Starting lunR");
		expect(terminal.starts).toBe(1);
	});

	it("does not count terminal setup writes as the first frame", async () => {
		view = new InteractiveView();
		view.start();
		let painted = false;
		void view.waitForFirstFrame().then(() => {
			painted = true;
		});
		await Promise.resolve();
		expect(painted).toBe(false);
		await view.waitForFirstFrame();
		expect(terminal.output).toContain("╰");
	});

	it("holds Enter and the editable draft until activation, then submits once", async () => {
		view = new InteractiveView();
		view.start();
		await view.waitForFirstFrame();
		const submit = vi.fn();
		view.editor.onSubmit = submit;
		terminal.input("hello");
		terminal.input("\r");
		terminal.input("\r");
		expect(submit).not.toHaveBeenCalled();
		expect(view.editor.getText()).toBe("hello");
		expect(view.editor.onPasteImage).toBeTypeOf("function");
		terminal.input("!");
		view.activate();
		expect(submit).toHaveBeenCalledExactlyOnceWith("hello!");
		expect(view.editor.onPasteImage).toBeUndefined();
	});

	it("preserves editor identity, cursor, and image chips when the real extension binds", async () => {
		view = new InteractiveView();
		view.start();
		await view.waitForFirstFrame();
		terminal.input("draft");
		const marker = view.editor.insertImageMarker({ path: "fixture.png", mimeType: "image/png" });
		terminal.input("\x1b[D");
		const cursor = view.editor.getCursor();
		const text = view.editor.getText();
		const { default: installTui } = await import("../src/builtin-extensions/ashxj-tui.ts");
		const { getEditorTheme, theme } = await import("../src/modes/interactive/theme/theme.ts");
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const setEditorComponent = vi.fn((factory) => {
			const editor = factory(view!.ui, getEditorTheme(), view!.keybindings);
			expect(editor).toBe(view!.editor);
		});
		installTui({ getThinkingLevel: () => "high", on: (event, handler) => handlers.set(event, handler as never) });
		handlers.get("session_start")?.(
			{},
			{
				mode: "tui",
				hasUI: true,
				model: { id: "ready-model", provider: "test" },
				ui: { theme, setEditorComponent, setFooter() {} },
			},
		);
		expect(setEditorComponent).toHaveBeenCalledOnce();
		expect(view.editor.getText()).toBe(text);
		expect(view.editor.getCursor()).toEqual(cursor);
		expect(view.editor.render(100).join("\n")).toContain("ready-model");
		expect(view.editor.takePendingImages()).toEqual([{ id: marker, path: "fixture.png", mimeType: "image/png" }]);
		expect(terminal.starts).toBe(1);
	});

	it("lets startup dialogs receive Enter without queuing the draft", async () => {
		view = new InteractiveView();
		view.start();
		await view.waitForFirstFrame();
		terminal.input("draft");
		const selection = view.select("Trust", [{ label: "Allow", value: true }]);
		await vi.waitFor(() => expect(view!.editor.focused).toBe(false));
		terminal.input("\r");
		await expect(selection).resolves.toBe(true);
		const submit = vi.fn();
		view.editor.onSubmit = submit;
		view.activate();
		expect(submit).not.toHaveBeenCalled();
		expect(view.editor.getText()).toBe("draft");
	});

	it("keeps the retained chatbox renderable after its session context is invalidated", async () => {
		view = new InteractiveView();
		const { default: installTui } = await import("../src/builtin-extensions/ashxj-tui.ts");
		const { getEditorTheme, theme } = await import("../src/modes/interactive/theme/theme.ts");
		let active = true;
		const assertActive = () => {
			if (!active) throw new Error("disposed session");
		};
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		installTui({
			getThinkingLevel: () => {
				assertActive();
				return "high";
			},
			on: (event, handler) => handlers.set(event, handler as never),
		});
		const ctx = {
			mode: "tui",
			hasUI: true,
			get model() {
				assertActive();
				return { id: "previous-model", provider: "test" };
			},
			get ui() {
				assertActive();
				return {
					theme,
					setFooter() {},
					setEditorComponent: (factory?: (ui: unknown, theme: unknown, keys: unknown) => unknown) => {
						factory?.(view!.ui, getEditorTheme(), view!.keybindings);
					},
				};
			},
		};
		handlers.get("session_start")?.({}, ctx);
		handlers.get("session_shutdown")?.({}, ctx);
		active = false;
		expect(() => view!.editor.render(100)).not.toThrow();
		expect(view.editor.render(100).join("\n")).toContain("previous-model");
	});

	it("keeps a failed-startup draft visible and supports exit", async () => {
		view = new InteractiveView();
		view.start();
		await view.waitForFirstFrame();
		terminal.input("draft");
		view.showError(new Error("fixture failure"));
		expect(view.editor.getText()).toBe("draft");
		expect(view.statusContainer.render(100).join("\n")).toContain("fixture failure");
		terminal.input("\x03");
		terminal.input("\x03");
		await expect(view.waitForExit()).resolves.toBeUndefined();
		expect(view.isExitRequested).toBe(true);
	});

	it.each([false, true])(
		"attaches InteractiveMode and gates commands on feature readiness, failure=%s",
		async (fail) => {
			view = new InteractiveView();
			view.start();
			await view.waitForFirstFrame();
			const [
				{ InteractiveMode },
				{ AgentSessionRuntime },
				{ createAgentSessionServices, createAgentSessionFromServices },
				{ SessionManager },
				{ SettingsManager },
				{ default: ashxjTui },
			] = await Promise.all([
				import("../src/modes/interactive/interactive-mode.ts"),
				import("../src/core/agent-session-runtime.ts"),
				import("../src/core/agent-session-services.ts"),
				import("../src/core/session-manager.ts"),
				import("../src/core/settings-manager.ts"),
				import("../src/builtin-extensions/ashxj-tui.ts"),
			]);
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				settingsManager: SettingsManager.inMemory({ theme: "moon", defaultPermissionMode: "manual" }),
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					extensionFactories: [{ name: "ashxj-tui", factory: ashxjTui as never }],
				},
			});
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(tempDir),
			});
			const runtime = new AgentSessionRuntime(session, services, async () => {
				throw new Error("unexpected session replacement");
			});
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const mode = new InteractiveMode(runtime, {
				startupView: view.binding(),
				deferredBuiltinFactories: async () => {
					await gate;
					if (fail) throw new Error("fixture feature failure");
					return [];
				},
			});
			const internal = mode as unknown as {
				editor: typeof view.editor;
				showSettingsSelector(): Promise<void>;
				maybeNotifyCliUpdate(): Promise<void>;
				startPlanUsagePolling(): void;
			};
			vi.spyOn(internal, "maybeNotifyCliUpdate").mockResolvedValue();
			vi.spyOn(internal, "startPlanUsagePolling").mockImplementation(() => {});
			const settings = vi.spyOn(internal, "showSettingsSelector").mockResolvedValue();
			const prompt = vi.spyOn(session, "prompt");
			try {
				terminal.input("/settings");
				terminal.input("\x1b[D");
				const cursor = view.editor.getCursor();
				await mode.init();
				expect(internal.editor).toBe(view.editor);
				expect(view.editor.getCursor()).toEqual(cursor);
				terminal.input("\r");
				expect(settings).not.toHaveBeenCalled();
				expect(terminal.starts).toBe(1);
				release();
				if (fail) {
					await expect(mode.waitForStartupReady()).rejects.toThrow("fixture feature failure");
					expect(view.editor.getText()).toBe("/settings");
					expect(settings).not.toHaveBeenCalled();
				} else {
					await mode.waitForStartupReady();
					await vi.waitFor(() => expect(settings).toHaveBeenCalledOnce());
				}
				expect(prompt).not.toHaveBeenCalled();
			} finally {
				release();
				mode.stop();
				await runtime.dispose();
			}
		},
	);
});
