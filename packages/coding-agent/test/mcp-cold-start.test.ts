import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeServerHash } from "../src/builtin-extensions/pi-mcp-adapter/metadata-cache.ts";

const ADAPTER_ROOT = join(process.cwd(), "src/builtin-extensions/pi-mcp-adapter");
const HEAVY_STATIC_IMPORTS = [
	"./init.ts",
	"./commands.ts",
	"./proxy-modes.ts",
	"./mcp-auth-flow.ts",
	"./direct-tool-executor.ts",
	"./server-manager.ts",
	"./lifecycle.ts",
	"./ui-session.ts",
	"./mcp-panel.ts",
	"./mcp-setup-panel.ts",
];

const HEAVY_PACKAGE_MARKERS = [
	"@modelcontextprotocol/sdk",
	"@modelcontextprotocol/ext-apps",
	"recheck",
];

type RegisteredTool = {
	name: string;
	description?: string;
	parameters?: unknown;
	execute?: (...args: unknown[]) => Promise<unknown>;
};

type RegisteredCommand = {
	name: string;
	handler: (args: string | undefined, ctx: MockContext) => Promise<void>;
};

type SessionHandler = (event: unknown, ctx: MockContext) => Promise<void> | void;

type MockContext = {
	hasUI: boolean;
	mode: string;
	cwd: string;
	ui: {
		notify: (message: string, level?: string) => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
	reload: () => Promise<void>;
	signal?: AbortSignal;
	model?: unknown;
	modelRegistry?: unknown;
};

function collectStaticImports(filePath: string, seen = new Set<string>()): string[] {
	const resolved = filePath;
	if (seen.has(resolved)) return [];
	seen.add(resolved);
	if (!existsSync(resolved)) return [];

	const source = readFileSync(resolved, "utf8");
	const imports: string[] = [];
	for (const match of source.matchAll(/(?:^|\n)import\s+(type\s+)?(?:[^"'\n]+from\s+)?["']([^"']+)["']/g)) {
		const isTypeOnly = Boolean(match[1]);
		const spec = match[2]!;
		if (isTypeOnly) continue;
		imports.push(spec);
		if (spec.startsWith(".")) {
			const base = join(resolved, "..", spec);
			const next = existsSync(base) ? base : `${base}.ts`;
			imports.push(...collectStaticImports(next, seen));
		}
	}
	return imports;
}

function createMockPi(cwd: string) {
	const tools: RegisteredTool[] = [];
	const commands = new Map<string, RegisteredCommand>();
	const flags = new Map<string, unknown>();
	const handlers = new Map<string, SessionHandler[]>();
	const notifications: Array<{ message: string; level?: string }> = [];

	const ctx: MockContext = {
		hasUI: false,
		mode: "print",
		cwd,
		ui: {
			notify: (message, level) => {
				notifications.push({ message, level });
			},
			setStatus: () => {},
		},
		reload: async () => {},
	};

	const pi = {
		tools,
		commands,
		handlers,
		notifications,
		ctx,
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand(name: string, spec: { description?: string; handler: RegisteredCommand["handler"] }) {
			commands.set(name, { name, handler: spec.handler });
		},
		registerFlag(name: string, _spec: unknown) {
			flags.set(name, undefined);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		setFlag(name: string, value: unknown) {
			flags.set(name, value);
		},
		on(event: string, handler: SessionHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getAllTools() {
			return tools.map((tool) => ({ name: tool.name }));
		},
		sendMessage() {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};

	return pi;
}

async function emit(pi: ReturnType<typeof createMockPi>, event: string) {
	for (const handler of pi.handlers.get(event) ?? []) {
		await handler({}, pi.ctx);
	}
}

function mockHeavyModules(options?: {
	initializeMcp?: () => Promise<unknown>;
	executeStatus?: (state: unknown) => Promise<unknown>;
	createDirectToolExecutor?: (...args: unknown[]) => (...args: unknown[]) => Promise<unknown>;
	onInitModuleLoad?: () => void;
}) {
	const gracefulShutdown = vi.fn(async () => {});
	const shutdownOAuth = vi.fn(async () => {});
	const initializeOAuth = vi.fn(async () => {});
	const flushMetadataCache = vi.fn();
	const updateStatusBar = vi.fn();
	const executeStatus =
		options?.executeStatus ??
		(async () => ({
			content: [{ type: "text", text: "status-ok" }],
			details: { ok: true },
		}));

	vi.doMock("../src/builtin-extensions/pi-mcp-adapter/init.ts", () => {
		options?.onInitModuleLoad?.();
		return {
			initializeMcp:
				options?.initializeMcp ??
				(async () => ({
					uiServer: null,
					lifecycle: { gracefulShutdown },
					manager: { getAllConnections: () => new Map() },
					config: { mcpServers: {} },
					toolMetadata: new Map(),
					failureTracker: new Map(),
				})),
			flushMetadataCache,
			updateStatusBar,
		};
	});
	vi.doMock("../src/builtin-extensions/pi-mcp-adapter/mcp-auth-flow.ts", () => ({
		initializeOAuth,
		shutdownOAuth,
	}));
	vi.doMock("../src/builtin-extensions/pi-mcp-adapter/commands.ts", () => ({
		showStatus: vi.fn(async () => {}),
		showTools: vi.fn(async () => {}),
		reconnectServers: vi.fn(async () => {}),
		openMcpSetup: vi.fn(async () => ({})),
		openMcpPanel: vi.fn(async () => ({})),
		openMcpAuthPanel: vi.fn(async () => {}),
		logoutServer: vi.fn(async () => {}),
		authenticateServer: vi.fn(async () => {}),
	}));
	vi.doMock("../src/builtin-extensions/pi-mcp-adapter/proxy-modes.ts", () => ({
		executeStatus,
		executeUiMessages: vi.fn(),
		executeAuthStart: vi.fn(),
		executeAuthComplete: vi.fn(),
		executeCall: vi.fn(),
		executeConnect: vi.fn(),
		executeDescribe: vi.fn(),
		executeSearch: vi.fn(),
		executeList: vi.fn(),
	}));
	vi.doMock("../src/builtin-extensions/pi-mcp-adapter/direct-tool-executor.ts", () => ({
		createDirectToolExecutor:
			options?.createDirectToolExecutor ??
			(() => async () => ({
				content: [{ type: "text", text: "direct-ok" }],
				details: {},
			})),
	}));

	return { gracefulShutdown, shutdownOAuth, initializeOAuth, flushMetadataCache, updateStatusBar };
}

describe("mcp cold-start dependency split", () => {
	const dirs: string[] = [];
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalDirectTools = process.env.MCP_DIRECT_TOOLS;
	const originalArgv = process.argv.slice();

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		delete process.env.MCP_DIRECT_TOOLS;
	});

	afterEach(() => {
		process.argv = originalArgv.slice();
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		if (originalDirectTools === undefined) delete process.env.MCP_DIRECT_TOOLS;
		else process.env.MCP_DIRECT_TOOLS = originalDirectTools;
		while (dirs.length > 0) {
			rmSync(dirs.pop()!, { recursive: true, force: true });
		}
		vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/init.ts");
		vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/mcp-auth-flow.ts");
		vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/commands.ts");
		vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/proxy-modes.ts");
		vi.doUnmock("../src/builtin-extensions/pi-mcp-adapter/direct-tool-executor.ts");
		vi.restoreAllMocks();
	});

	function tempAgentDir(): string {
		const dir = join(tmpdir(), `lunr-mcp-cold-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		dirs.push(dir);
		process.env.PI_CODING_AGENT_DIR = dir;
		return dir;
	}

	function writeConfig(agentDir: string, config: unknown) {
		const path = join(agentDir, "mcp.json");
		writeFileSync(path, JSON.stringify(config, null, 2), "utf8");
		return path;
	}

	function writeCache(agentDir: string, servers: Record<string, unknown>) {
		const path = join(agentDir, "mcp-cache.json");
		writeFileSync(path, JSON.stringify({ version: 1, servers }, null, 2), "utf8");
		return path;
	}

	it("keeps index static imports free of heavy MCP runtime modules", () => {
		const imports = collectStaticImports(join(ADAPTER_ROOT, "index.ts"));
		for (const heavy of HEAVY_STATIC_IMPORTS) {
			expect(imports, `static graph should not include ${heavy}`).not.toContain(heavy);
		}
		for (const marker of HEAVY_PACKAGE_MARKERS) {
			const runtimeHits = imports.filter((spec) => spec.includes(marker));
			expect(runtimeHits, `runtime graph should not include ${marker}`).toEqual([]);
		}

		const directToolsSource = readFileSync(join(ADAPTER_ROOT, "direct-tools.ts"), "utf8");
		expect(directToolsSource).not.toMatch(/createDirectToolExecutor/);
		expect(directToolsSource).not.toMatch(/@modelcontextprotocol/);
		expect(directToolsSource).not.toMatch(/from "\.\/init\.ts"/);
		expect(directToolsSource).not.toMatch(/from "\.\/mcp-auth-flow\.ts"/);

		const metadataCacheSource = readFileSync(join(ADAPTER_ROOT, "metadata-cache.ts"), "utf8");
		expect(metadataCacheSource).not.toMatch(/^import .*@modelcontextprotocol/m);
	});

	it("registers proxy and cached direct tools without loading heavy runtime modules", async () => {
		const agentDir = tempAgentDir();
		const serverDef = { command: "echo", args: ["ok"], directTools: true as const };
		const configPath = writeConfig(agentDir, {
			mcpServers: { playwright: serverDef },
			settings: { toolPrefix: "server" },
		});
		writeCache(agentDir, {
			playwright: {
				configHash: computeServerHash(serverDef),
				cachedAt: Date.now(),
				tools: [
					{
						name: "click",
						description: "Click a selector",
						inputSchema: {
							type: "object",
							properties: { selector: { type: "string" } },
							required: ["selector"],
						},
					},
				],
				resources: [],
			},
		});
		process.argv = ["node", "lunr", "--mcp-config", configPath];

		let heavyLoaded = false;
		const blockHeavy = () => {
			heavyLoaded = true;
			throw new Error("heavy MCP runtime should not load during registration");
		};
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/init.ts", blockHeavy);
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/mcp-auth-flow.ts", blockHeavy);
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/commands.ts", blockHeavy);
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/proxy-modes.ts", blockHeavy);
		vi.doMock("../src/builtin-extensions/pi-mcp-adapter/direct-tool-executor.ts", blockHeavy);

		const mod = await import("../src/builtin-extensions/pi-mcp-adapter/index.ts");
		const pi = createMockPi(agentDir);
		mod.default(pi);

		expect(heavyLoaded).toBe(false);
		expect(pi.tools.map((tool) => tool.name).sort()).toEqual(["mcp", "playwright_click"].sort());
		expect(pi.commands.has("mcp")).toBe(true);
		expect(pi.commands.has("mcp-auth")).toBe(true);

		const direct = pi.tools.find((tool) => tool.name === "playwright_click");
		expect(direct?.description).toBe("Click a selector");
		expect(direct?.parameters).toBeTruthy();

		const proxy = pi.tools.find((tool) => tool.name === "mcp");
		expect(proxy?.description).toContain("Direct tools available");
		expect(proxy?.description).toContain("playwright");
		expect(proxy?.description).toContain('mcp({ action: "auth-start"');

		await emit(pi, "session_start");
		expect(heavyLoaded).toBe(false);
		await emit(pi, "session_shutdown");
		expect(heavyLoaded).toBe(false);
	});

	it("loads heavy runtime once on first tool use and retries after init failure", async () => {
		const agentDir = tempAgentDir();
		const serverDef = { command: "true", lifecycle: "lazy" };
		const configPath = writeConfig(agentDir, {
			mcpServers: { lazy: serverDef },
		});
		writeCache(agentDir, {
			lazy: {
				configHash: computeServerHash(serverDef),
				cachedAt: Date.now(),
				tools: [{ name: "ping", description: "Ping" }],
				resources: [],
			},
		});
		process.argv = ["node", "lunr", "--mcp-config", configPath];

		let initCalls = 0;
		let loadCount = 0;
		mockHeavyModules({
			onInitModuleLoad: () => {
				loadCount += 1;
			},
			initializeMcp: async () => {
				initCalls += 1;
				if (initCalls === 1) {
					throw new Error("boom");
				}
				return {
					uiServer: null,
					lifecycle: { gracefulShutdown: vi.fn(async () => {}) },
					manager: { getAllConnections: () => new Map() },
					config: { mcpServers: { lazy: serverDef } },
					toolMetadata: new Map(),
					failureTracker: new Map(),
				};
			},
		});

		const mod = await import("../src/builtin-extensions/pi-mcp-adapter/index.ts");
		const pi = createMockPi(agentDir);
		mod.default(pi);

		await emit(pi, "session_start");
		expect(loadCount).toBe(0);
		expect(initCalls).toBe(0);

		const proxy = pi.tools.find((tool) => tool.name === "mcp");
		expect(proxy?.execute).toBeTypeOf("function");

		const first = (await proxy!.execute!("call-1", {}, undefined, undefined, pi.ctx)) as {
			details?: { error?: string; message?: string };
			content: Array<{ text: string }>;
		};
		expect(first.details?.error).toBe("init_failed");
		expect(first.content[0]?.text).toContain("boom");
		expect(loadCount).toBe(1);
		expect(initCalls).toBe(1);

		const second = (await proxy!.execute!("call-2", {}, undefined, undefined, pi.ctx)) as {
			content: Array<{ text: string }>;
			details?: { ok?: boolean };
		};
		expect(second.content[0]?.text).toBe("status-ok");
		expect(second.details?.ok).toBe(true);
		expect(loadCount).toBe(1);
		expect(initCalls).toBe(2);
	});

	it("does not let a stale init assign state after session shutdown", async () => {
		const agentDir = tempAgentDir();
		const configPath = writeConfig(agentDir, {
			mcpServers: { keep: { command: "true", lifecycle: "keep-alive" } },
		});
		process.argv = ["node", "lunr", "--mcp-config", configPath];

		let releaseInit: (value?: unknown) => void = () => {};
		const initGate = new Promise<void>((resolve) => {
			releaseInit = resolve;
		});
		let sawInitStart!: () => void;
		const initStarted = new Promise<void>((resolve) => {
			sawInitStart = resolve;
		});
		const gracefulShutdown = vi.fn(async () => {});
		const states: Array<{ id: number }> = [];

		mockHeavyModules({
			initializeMcp: async () => {
				sawInitStart();
				await initGate;
				const state = {
					uiServer: null,
					lifecycle: { gracefulShutdown },
					manager: { getAllConnections: () => new Map() },
					config: { mcpServers: { keep: { command: "true", lifecycle: "keep-alive" } } },
					id: states.length + 1,
				};
				states.push(state);
				return state;
			},
			executeStatus: async (state: { id: number }) => ({
				content: [{ type: "text", text: `state-${state.id}` }],
				details: { id: state.id },
			}),
		});

		const mod = await import("../src/builtin-extensions/pi-mcp-adapter/index.ts");
		const pi = createMockPi(agentDir);
		mod.default(pi);

		const sessionStart = emit(pi, "session_start");
		await initStarted;
		await sessionStart;
		await emit(pi, "session_shutdown");
		releaseInit();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(gracefulShutdown).toHaveBeenCalled();

		const proxy = pi.tools.find((tool) => tool.name === "mcp");
		const result = (await proxy!.execute!("call", {}, undefined, undefined, pi.ctx)) as {
			content: Array<{ text: string }>;
			details?: { id?: number };
		};
		expect(result.details?.id).toBe(2);
		expect(result.content[0]?.text).toBe("state-2");
		expect(states).toHaveLength(2);
	});

	it("background-autostarts eager servers without blocking registration", async () => {
		const agentDir = tempAgentDir();
		const configPath = writeConfig(agentDir, {
			mcpServers: { hot: { command: "true", lifecycle: "eager" } },
		});
		process.argv = ["node", "lunr", "--mcp-config", configPath];

		let resolveInit!: () => void;
		const initGate = new Promise<void>((resolve) => {
			resolveInit = resolve;
		});
		let sawInitStart!: () => void;
		const initStarted = new Promise<void>((resolve) => {
			sawInitStart = resolve;
		});

		mockHeavyModules({
			initializeMcp: async () => {
				sawInitStart();
				await initGate;
				return {
					uiServer: null,
					lifecycle: { gracefulShutdown: async () => {} },
					manager: { getAllConnections: () => new Map() },
					config: { mcpServers: { hot: { command: "true", lifecycle: "eager" } } },
				};
			},
			executeStatus: async () => ({
				content: [{ type: "text", text: "ready" }],
				details: {},
			}),
		});

		const mod = await import("../src/builtin-extensions/pi-mcp-adapter/index.ts");
		const pi = createMockPi(agentDir);
		mod.default(pi);
		expect(pi.tools.some((tool) => tool.name === "mcp")).toBe(true);

		const sessionStartDone = emit(pi, "session_start");
		await initStarted;
		await sessionStartDone;

		resolveInit();
		const proxy = pi.tools.find((tool) => tool.name === "mcp");
		const result = (await proxy!.execute!("call", {}, undefined, undefined, pi.ctx)) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0]?.text).toBe("ready");
	});

	it("preserves proxy fallback when configured direct tools lack cache metadata", async () => {
		const agentDir = tempAgentDir();
		const configPath = writeConfig(agentDir, {
			mcpServers: {
				missing: { command: "true", directTools: true },
			},
			settings: { disableProxyTool: true },
		});
		writeCache(agentDir, {});
		process.argv = ["node", "lunr", "--mcp-config", configPath];

		const mod = await import("../src/builtin-extensions/pi-mcp-adapter/index.ts");
		const pi = createMockPi(agentDir);
		mod.default(pi);

		expect(pi.tools.map((tool) => tool.name)).toEqual(["mcp"]);
		const proxy = pi.tools.find((tool) => tool.name === "mcp");
		expect(proxy?.description).toContain("MCP gateway");
	});
});
