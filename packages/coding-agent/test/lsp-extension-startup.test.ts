import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import lspExtension from "../src/builtin-extensions/pi-lsp-extension/src/index.ts";
import {
	type LspRuntimeBindOptions,
	LspRuntimeHost,
	type LspRuntimeModuleLoaders,
	type LspRuntimeServices,
} from "../src/builtin-extensions/pi-lsp-extension/src/runtime.ts";

type RegisteredTool = {
	name: string;
	description?: string;
	parameters?: unknown;
	execute: (...args: unknown[]) => Promise<unknown>;
};

type RegisteredCommand = {
	name: string;
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
};

type HookHandler = (...args: unknown[]) => unknown;

function createBindOptions(cwd: string, overrides: Partial<LspRuntimeBindOptions> = {}): LspRuntimeBindOptions {
	return {
		cwd,
		callbacks: {},
		pendingProvider: null,
		syntheticDotChecker: () => false,
		...overrides,
	};
}

function createMockServices(cwd: string) {
	const startEagerly = vi.fn();
	const shutdownAll = vi.fn(async () => {});
	const treeShutdown = vi.fn();
	const manager = {
		setWorkspaceProvider: vi.fn(),
		setServerConfig: vi.fn(),
		setLombokJar: vi.fn(),
		getLombokJar: vi.fn(() => null),
		startEagerly,
		shutdownAll,
		getStatus: vi.fn(() => []),
		getLanguageId: vi.fn(() => "typescript"),
		getFileUri: vi.fn((p: string) => `file://${p}`),
		resolvePath: vi.fn((p: string) => (p === "." ? cwd : join(cwd, p))),
		getRunningClient: vi.fn(() => undefined),
		restartServer: vi.fn(async () => {}),
		getClientForFile: vi.fn(async () => null),
	};
	const fileSync = {
		handleFileRead: vi.fn(async () => {}),
		handleFileWrite: vi.fn(async () => {}),
		getTrackedVersion: vi.fn(() => null),
		setTrackedVersion: vi.fn(),
		setSyntheticDotChecker: vi.fn(),
		setTreeSitter: vi.fn(),
	};
	const treeSitter = {
		init: vi.fn(async () => {}),
		shutdown: treeShutdown,
		parse: vi.fn(async () => null),
	};
	const workspaceIndex = {};
	const services = { manager, fileSync, treeSitter, workspaceIndex } as unknown as LspRuntimeServices;
	return { services, startEagerly, shutdownAll, treeShutdown, manager, fileSync, treeSitter };
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createConstructorMock<T>(instance: T) {
	return vi.fn(function ConstructorMock() {
		return instance;
	});
}

function createLoadersFromServices(
	getServices: () => ReturnType<typeof createMockServices>["services"],
	gates?: { beforeLoad?: () => Promise<void> },
): LspRuntimeModuleLoaders {
	const wrap = async <T>(factory: () => T): Promise<T> => {
		if (gates?.beforeLoad) await gates.beforeLoad();
		return factory();
	};
	return {
		async loadLspManager() {
			return wrap(() => {
				const services = getServices();
				return {
					LspManager: createConstructorMock(services.manager) as never,
				};
			});
		},
		async loadFileSync() {
			return wrap(() => {
				const services = getServices();
				return {
					FileSync: createConstructorMock(services.fileSync) as never,
				};
			});
		},
		async loadTreeSitter() {
			return wrap(() => {
				const services = getServices();
				return {
					TreeSitterManager: createConstructorMock(services.treeSitter) as never,
				};
			});
		},
		async loadWorkspaceIndex() {
			return wrap(() => {
				const services = getServices();
				return {
					WorkspaceIndex: createConstructorMock(services.workspaceIndex) as never,
				};
			});
		},
	};
}

function createExtensionHarness(factory: (pi: never) => void = lspExtension) {
	const tools: RegisteredTool[] = [];
	const commands: RegisteredCommand[] = [];
	const hooks = new Map<string, HookHandler[]>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses: string[] = [];

	const ui = {
		notify(message: string, level?: string) {
			notifications.push({ message, level });
		},
		setStatus(_id: string, text: string) {
			statuses.push(text);
		},
		theme: {
			fg(_color: string, text: string) {
				return text;
			},
		},
	};

	const ctx = {
		cwd: process.cwd(),
		ui,
	};

	const api = {
		events: {
			on() {},
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string, def: { description?: string; handler: RegisteredCommand["handler"] }) {
			commands.push({ name, description: def.description, handler: def.handler });
		},
		on(event: string, handler: HookHandler) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
		},
	};

	factory(api as never);

	async function emit(event: string, eventPayload: unknown = {}, eventCtx: unknown = ctx) {
		for (const handler of hooks.get(event) ?? []) {
			await handler(eventPayload, eventCtx);
		}
	}

	return {
		tools,
		commands,
		hooks,
		notifications,
		statuses,
		ctx,
		emit,
		setCwd(cwd: string) {
			ctx.cwd = cwd;
		},
	};
}

describe("LspRuntimeHost lazy loading", () => {
	it("shares one in-flight initialization across concurrent callers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-runtime-concurrent-"));
		const gate = createDeferred<void>();
		let loaderBatches = 0;
		const mock = createMockServices(cwd);
		const host = new LspRuntimeHost(
			createLoadersFromServices(() => mock.services, {
				beforeLoad: async () => {
					loaderBatches += 1;
					await gate.promise;
				},
			}),
		);
		host.bindSession(createBindOptions(cwd));

		const p1 = host.ensureServices();
		const p2 = host.ensureServices();
		expect(host.hasServices()).toBe(false);
		gate.resolve();
		const [a, b] = await Promise.all([p1, p2]);
		expect(a).toBe(b);
		// Four module loaders run once for the shared init promise.
		expect(loaderBatches).toBe(4);
		expect(host.hasServices()).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("allows recovery after a rejected load", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-runtime-recover-"));
		let shouldFail = true;
		const mock = createMockServices(cwd);
		const host = new LspRuntimeHost({
			async loadLspManager() {
				if (shouldFail) throw new Error("boom");
				return {
					LspManager: createConstructorMock(mock.manager) as never,
				};
			},
			async loadFileSync() {
				return {
					FileSync: createConstructorMock(mock.fileSync) as never,
				};
			},
			async loadTreeSitter() {
				return {
					TreeSitterManager: createConstructorMock(mock.treeSitter) as never,
				};
			},
			async loadWorkspaceIndex() {
				return {
					WorkspaceIndex: createConstructorMock(mock.workspaceIndex) as never,
				};
			},
		});
		host.bindSession(createBindOptions(cwd));

		await expect(host.ensureServices()).rejects.toThrow("boom");
		expect(host.hasServices()).toBe(false);

		shouldFail = false;
		const services = await host.ensureServices();
		expect(services.manager).toBe(mock.manager);
		expect(host.hasServices()).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	it("invalidates in-flight initialization on rebind", async () => {
		const cwd1 = mkdtempSync(join(tmpdir(), "lsp-runtime-rebind-a-"));
		const cwd2 = mkdtempSync(join(tmpdir(), "lsp-runtime-rebind-b-"));
		const gate = createDeferred<void>();
		const first = createMockServices(cwd1);
		const second = createMockServices(cwd2);
		let phase: "first" | "second" = "first";

		const host = new LspRuntimeHost(
			createLoadersFromServices(() => (phase === "first" ? first.services : second.services), {
				beforeLoad: async () => {
					await gate.promise;
				},
			}),
		);

		host.bindSession(createBindOptions(cwd1));
		const firstEnsure = host.ensureServices();
		phase = "second";
		host.bindSession(createBindOptions(cwd2));
		gate.resolve();
		await expect(firstEnsure).rejects.toThrow(/session replaced/);
		expect(host.hasServices()).toBe(false);

		const ready = await host.ensureServices();
		expect(ready.manager).toBe(second.manager);

		rmSync(cwd1, { recursive: true, force: true });
		rmSync(cwd2, { recursive: true, force: true });
	});

	it("shutdown during loading prevents stale attachment and never-used shutdown loads nothing", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-runtime-shutdown-"));
		const gate = createDeferred<void>();
		const mock = createMockServices(cwd);
		const host = new LspRuntimeHost(
			createLoadersFromServices(() => mock.services, {
				beforeLoad: async () => {
					await gate.promise;
				},
			}),
		);

		host.bindSession(createBindOptions(cwd));
		const loading = host.ensureServices();
		await host.shutdown();
		gate.resolve();
		await expect(loading).rejects.toThrow(/session replaced/);
		expect(host.hasServices()).toBe(false);

		let loads = 0;
		const unused = new LspRuntimeHost({
			async loadLspManager() {
				loads += 1;
				throw new Error("should not load");
			},
			async loadFileSync() {
				loads += 1;
				throw new Error("should not load");
			},
			async loadTreeSitter() {
				loads += 1;
				throw new Error("should not load");
			},
			async loadWorkspaceIndex() {
				loads += 1;
				throw new Error("should not load");
			},
		});
		unused.bindSession(createBindOptions(cwd));
		await unused.shutdown();
		expect(loads).toBe(0);

		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("pi-lsp-extension startup readiness", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts");
		vi.doUnmock("../src/builtin-extensions/pi-lsp-extension/src/file-sync.ts");
		vi.doUnmock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts");
		vi.doUnmock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/workspace-index.ts");
		while (dirs.length > 0) {
			rmSync(dirs.pop()!, { recursive: true, force: true });
		}
	});

	it("registers exact tool schemas and commands before any heavy runtime load", async () => {
		const harness = createExtensionHarness();

		const toolNames = harness.tools.map((tool) => tool.name).sort();
		expect(toolNames).toEqual(
			[
				"ast_search",
				"code_overview",
				"code_rewrite",
				"lsp_code_actions",
				"lsp_completions",
				"lsp_definition",
				"lsp_diagnostics",
				"lsp_hover",
				"lsp_references",
				"lsp_rename",
				"lsp_symbols",
			].sort(),
		);

		for (const tool of harness.tools) {
			expect(tool.parameters).toBeTruthy();
			expect(typeof tool.execute).toBe("function");
		}

		const commandNames = harness.commands.map((command) => command.name).sort();
		expect(commandNames).toEqual(["lsp", "lsp-config", "lsp-lombok", "lsp-restart"].sort());
		expect(harness.hooks.has("session_start")).toBe(true);
		expect(harness.hooks.has("session_shutdown")).toBe(true);
		expect(harness.hooks.has("tool_result")).toBe(true);
		expect(harness.hooks.has("tool_execution_end")).toBe(true);
	});

	it("session_start without autoStart stays ready while heavy imports are stalled", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-ext-stall-"));
		dirs.push(cwd);

		let heavyLoads = 0;
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts", () => {
			heavyLoads += 1;
			return new Promise(() => {});
		});

		const harness = createExtensionHarness();
		harness.setCwd(cwd);

		const start = harness.emit("session_start", { type: "session_start" }, harness.ctx);
		await expect(
			Promise.race([
				start.then(() => "ready" as const),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
			]),
		).resolves.toBe("ready");
		await start;

		expect(harness.statuses.some((status) => status.includes("LSP: idle"))).toBe(true);
		expect(heavyLoads).toBe(0);
	});

	it("first tool use waits for runtime initialization before execute body runs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-ext-first-use-"));
		dirs.push(cwd);

		const gate = createDeferred<void>();
		let constructed = 0;
		const startEagerly = vi.fn();

		vi.resetModules();
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts", async () => {
			await gate.promise;
			constructed += 1;
			return {
				LspManager: class {
					constructor(public rootDir: string) {}
					setWorkspaceProvider() {}
					setServerConfig() {}
					setLombokJar() {}
					getLombokJar() {
						return null;
					}
					startEagerly = startEagerly;
					async shutdownAll() {}
					getStatus() {
						return [];
					}
					getLanguageId() {
						return undefined;
					}
					getFileUri(path: string) {
						return `file://${path}`;
					}
					resolvePath(path: string) {
						return path === "." ? cwd : join(cwd, path);
					}
					getRunningClient() {
						return undefined;
					}
					async getClientForFile() {
						return null;
					}
					async restartServer() {}
				},
			};
		});
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/file-sync.ts", () => ({
			FileSync: class {
				setSyntheticDotChecker() {}
				setTreeSitter() {}
				async handleFileRead() {}
				async handleFileWrite() {}
				getTrackedVersion() {
					return null;
				}
				setTrackedVersion() {}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts", () => ({
			TreeSitterManager: class {
				async init() {}
				shutdown() {}
				async parse() {
					return null;
				}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/workspace-index.ts", () => ({
			WorkspaceIndex: class {},
		}));

		const { default: freshExtension } = await import("../src/builtin-extensions/pi-lsp-extension/src/index.ts");
		const harness = createExtensionHarness(freshExtension);
		harness.setCwd(cwd);
		await harness.emit("session_start", { type: "session_start" }, harness.ctx);

		const diagnostics = harness.tools.find((tool) => tool.name === "lsp_diagnostics");
		expect(diagnostics).toBeTruthy();

		let finished = false;
		const pending = diagnostics!
			.execute("call-1", { path: "*" }, new AbortController().signal, undefined, {})
			.then((result) => {
				finished = true;
				return result;
			});

		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(finished).toBe(false);
		expect(constructed).toBe(0);

		gate.resolve();
		await pending;
		expect(finished).toBe(true);
		expect(constructed).toBe(1);
	});

	it("does not run an old write-result hook against replacement services", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-old-write-"));
		dirs.push(cwd);
		const old = createMockServices(cwd);
		const replacement = createMockServices(join(cwd, "next"));
		let current = old.services;
		const gate = createDeferred<void>();
		old.fileSync.handleFileWrite.mockImplementation(() => gate.promise);
		vi.spyOn(LspRuntimeHost.prototype, "ensureServices").mockImplementation(async () => current);
		vi.spyOn(LspRuntimeHost.prototype, "getServicesIfReady").mockImplementation(() => current);
		const harness = createExtensionHarness();
		harness.setCwd(cwd);
		await harness.emit("session_start", {}, harness.ctx);
		const pending = harness.emit("tool_result", {
			type: "tool_result",
			toolName: "write",
			input: { path: "index.ts" },
			content: [],
			isError: false,
		});
		await vi.waitFor(() => expect(old.fileSync.handleFileWrite).toHaveBeenCalled());
		current = replacement.services;
		harness.setCwd(join(cwd, "next"));
		await harness.emit("session_start", {}, harness.ctx);
		gate.resolve();
		await pending;
		expect(replacement.manager.getLanguageId).not.toHaveBeenCalled();
	});

	it("autoStart from .pi-lsp.json still ensures runtime and starts languages", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-ext-autostart-"));
		dirs.push(cwd);
		writeFileSync(
			join(cwd, ".pi-lsp.json"),
			JSON.stringify({
				autoStart: ["typescript"],
				servers: { typescript: { command: "typescript-language-server", args: ["--stdio"] } },
			}),
			"utf-8",
		);

		const startEagerly = vi.fn();
		const constructed: string[] = [];

		vi.resetModules();
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts", () => ({
			LspManager: class {
				constructor(public rootDir: string) {
					constructed.push(rootDir);
				}
				setWorkspaceProvider() {}
				setServerConfig() {}
				setLombokJar() {}
				getLombokJar() {
					return null;
				}
				startEagerly = startEagerly;
				async shutdownAll() {}
				getStatus() {
					return [];
				}
				getLanguageId() {
					return "typescript";
				}
				getFileUri(path: string) {
					return `file://${path}`;
				}
				resolvePath(path: string) {
					return path === "." ? cwd : join(cwd, path);
				}
				getRunningClient() {
					return undefined;
				}
				async restartServer() {}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/file-sync.ts", () => ({
			FileSync: class {
				setSyntheticDotChecker() {}
				setTreeSitter() {}
				async handleFileRead() {}
				async handleFileWrite() {}
				getTrackedVersion() {
					return null;
				}
				setTrackedVersion() {}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts", () => ({
			TreeSitterManager: class {
				async init() {}
				shutdown() {}
			},
		}));
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/workspace-index.ts", () => ({
			WorkspaceIndex: class {},
		}));

		const { default: freshExtension } = await import("../src/builtin-extensions/pi-lsp-extension/src/index.ts");
		const harness = createExtensionHarness(freshExtension);
		harness.setCwd(cwd);
		await harness.emit("session_start", { type: "session_start" }, harness.ctx);

		await vi.waitFor(() => expect(startEagerly).toHaveBeenCalledWith(["typescript"]));
		expect(constructed).toEqual([cwd]);
		expect(harness.statuses.some((status) => status.includes("auto-starting typescript"))).toBe(true);
		expect(harness.tools.some((tool) => tool.name === "lsp_hover")).toBe(true);
	});

	it("session_shutdown without prior use does not construct heavy managers", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "lsp-ext-shutdown-unused-"));
		dirs.push(cwd);

		let loads = 0;
		vi.resetModules();
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.ts", () => {
			loads += 1;
			return { LspManager: class {} };
		});
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/file-sync.ts", () => {
			loads += 1;
			return { FileSync: class {} };
		});
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/parser-manager.ts", () => {
			loads += 1;
			return { TreeSitterManager: class {} };
		});
		vi.doMock("../src/builtin-extensions/pi-lsp-extension/src/tree-sitter/workspace-index.ts", () => {
			loads += 1;
			return { WorkspaceIndex: class {} };
		});

		const { default: freshExtension } = await import("../src/builtin-extensions/pi-lsp-extension/src/index.ts");
		const harness = createExtensionHarness(freshExtension);
		harness.setCwd(cwd);
		await harness.emit("session_start", { type: "session_start" }, harness.ctx);
		await harness.emit("session_shutdown", { type: "session_shutdown" }, harness.ctx);
		expect(loads).toBe(0);
	});
});
