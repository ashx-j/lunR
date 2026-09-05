// @ts-nocheck
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import type { DirectToolSpec, McpConfig } from "./types.ts";
import type { MetadataCache } from "./metadata-cache.ts";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { buildProxyDescription, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tools.ts";
import { getMetadataCachePath, loadMetadataCache } from "./metadata-cache.ts";
import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";
import { createMcpDirectToolCallRenderer, renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { toolErrorOverride } from "./error-signal.ts";

type McpHeavyModules = {
  init: typeof import("./init.ts");
  authFlow: typeof import("./mcp-auth-flow.ts");
  commands: typeof import("./commands.ts");
  proxyModes: typeof import("./proxy-modes.ts");
  directToolExecutor: typeof import("./direct-tool-executor.ts");
};

function shouldBackgroundAutostart(config: McpConfig, cache: MetadataCache | null): boolean {
  const serverEntries = Object.entries(config.mcpServers);
  if (serverEntries.length === 0) return false;

  if (!existsSync(getMetadataCachePath())) return true;

  for (const [, definition] of serverEntries) {
    const mode = definition.lifecycle ?? "lazy";
    if (mode === "keep-alive" || mode === "eager") return true;
  }

  if (process.env.MCP_DIRECT_TOOLS === "__none__") return false;
  return getMissingConfiguredDirectToolServers(config, cache).length > 0;
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;
  let heavyModules: McpHeavyModules | null = null;
  let heavyModulesPromise: Promise<McpHeavyModules> | null = null;
  const directExecutors = new Map<string, ReturnType<McpHeavyModules["directToolExecutor"]["createDirectToolExecutor"]>>();

  function loadHeavyModules(): Promise<McpHeavyModules> {
    if (heavyModules) return Promise.resolve(heavyModules);
    if (!heavyModulesPromise) {
      heavyModulesPromise = (async () => {
        const [init, authFlow, commands, proxyModes, directToolExecutor] = await Promise.all([
          import("./init.ts"),
          import("./mcp-auth-flow.ts"),
          import("./commands.ts"),
          import("./proxy-modes.ts"),
          import("./direct-tool-executor.ts"),
        ]);
        const loaded: McpHeavyModules = { init, authFlow, commands, proxyModes, directToolExecutor };
        heavyModules = loaded;
        return loaded;
      })();
    }
    return heavyModulesPromise;
  }

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      if (heavyModules) {
        heavyModules.init.flushMetadataCache(currentState);
      }
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  async function shutdownLoadedRuntime(): Promise<void> {
    if (heavyModulesPromise) {
      try {
        await heavyModulesPromise;
      } catch {
        // Ignore load failures during cleanup.
      }
    }
    if (!heavyModules) return;
    await heavyModules.authFlow.shutdownOAuth();
  }

  async function runInitialize(
    generation: number,
    sessionPi: ExtensionAPI,
    ctx: ExtensionContext,
  ): Promise<McpExtensionState> {
    const heavy = await loadHeavyModules();
    if (generation !== lifecycleGeneration) {
      throw new Error("MCP initialization aborted (session changed)");
    }

    await heavy.authFlow.initializeOAuth().catch(err => {
      console.error("MCP OAuth initialization failed:", err);
    });

    if (generation !== lifecycleGeneration) {
      throw new Error("MCP initialization aborted (session changed)");
    }

    return heavy.init.initializeMcp(sessionPi, ctx);
  }

  function startSessionInit(generation: number, sessionPi: ExtensionAPI, ctx: ExtensionContext): Promise<McpExtensionState> {
    const promise = runInitialize(generation, sessionPi, ctx);
    initPromise = promise;

    promise.then(async (nextState) => {
      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return;
      }

      state = nextState;
      if (heavyModules) {
        heavyModules.init.updateStatusBar(nextState);
      }
      initPromise = null;
    }).catch(err => {
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });

    return promise;
  }

  async function ensureState(sessionPi: ExtensionAPI, ctx: ExtensionContext): Promise<McpExtensionState> {
    if (state) return state;

    const generation = lifecycleGeneration;
    if (!initPromise) {
      startSessionInit(generation, sessionPi, ctx);
    }
    const promise = initPromise;
    if (!promise) {
      throw new Error("MCP not initialized");
    }

    try {
      const nextState = await promise;
      if (generation !== lifecycleGeneration) {
        if (state) return state;
        throw new Error("MCP initialization aborted (session changed)");
      }
      if (state) return state;
      state = nextState;
      if (initPromise === promise) {
        initPromise = null;
      }
      return state;
    } catch (error) {
      if (initPromise === promise) {
        initPromise = null;
      }
      throw error;
    }
  }

  function createLazyDirectToolExecute(spec: DirectToolSpec) {
    return async function execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        await ensureState(pi, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
          details: { error: "init_failed", message },
        };
      }

      const heavy = await loadHeavyModules();
      let executor = directExecutors.get(spec.prefixedName);
      if (!executor) {
        executor = heavy.directToolExecutor.createDirectToolExecutor(() => state, () => initPromise, spec);
        directExecutors.set(spec.prefixedName, executor);
      }
      return executor(toolCallId, params, signal, onUpdate, ctx);
    };
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema) as never),
      execute: createLazyDirectToolExecute(spec),
      renderCall: createMcpDirectToolCallRenderer(spec.prefixedName),
      renderResult: renderMcpToolResult,
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;
    directExecutors.clear();

    try {
      await Promise.all([
        shutdownState(previousState, "session_restart"),
        shutdownLoadedRuntime(),
      ]);
    } catch (error) {
      console.error("MCP: failed to shut down previous session state", error);
    }

    if (generation !== lifecycleGeneration) {
      return;
    }

    const configPath = (pi.getFlag("mcp-config") as string | undefined) ?? earlyConfigPath;
    const sessionConfig = loadMcpConfig(configPath, ctx.cwd);
    const sessionCache = loadMetadataCache();

    if (!shouldBackgroundAutostart(sessionConfig, sessionCache)) {
      return;
    }

    startSessionInit(generation, pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;
    directExecutors.clear();

    try {
      await Promise.all([
        shutdownState(currentState, "session_shutdown"),
        shutdownLoadedRuntime(),
      ]);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  // Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
  pi.on("tool_result", (event) => toolErrorOverride(event.details));

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      let currentState: McpExtensionState;
      try {
        currentState = await ensureState(pi, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }

      const heavy = await loadHeavyModules();
      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      switch (subcommand) {
        case "reconnect":
          await heavy.commands.reconnectServers(currentState, ctx, targetServer);
          break;
        case "tools":
          await heavy.commands.showTools(currentState, ctx);
          break;
        case "setup": {
          const result = await heavy.commands.openMcpSetup(currentState, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await heavy.commands.logoutServer(serverName, currentState, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await heavy.commands.openMcpPanel(currentState, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await heavy.commands.showStatus(currentState, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      let currentState: McpExtensionState;
      try {
        currentState = await ensureState(pi, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
        return;
      }

      const heavy = await loadHeavyModules();

      if (!serverName) {
        await heavy.commands.openMcpAuthPanel(currentState, pi, ctx, earlyConfigPath);
        return;
      }

      await heavy.commands.authenticateServer(serverName, currentState.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      renderCall: renderMcpProxyToolCall,
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
      }),
      renderResult: renderMcpToolResult,
      async execute(_toolCallId, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
      }, signal, _onUpdate, ctx) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        let currentState: McpExtensionState;
        try {
          currentState = await ensureState(pi, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
            details: { error: "init_failed", message },
          };
        }

        const heavy = await loadHeavyModules();

        if (params.action === "ui-messages") {
          return heavy.proxyModes.executeUiMessages(currentState);
        }
        if (params.action === "auth-start") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
              details: { mode: "auth-start", error: "missing_server" },
            };
          }
          return heavy.proxyModes.executeAuthStart(currentState, params.server);
        }
        if (params.action === "auth-complete") {
          if (!params.server) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
              details: { mode: "auth-complete", error: "missing_server" },
            };
          }
          const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
          if (typeof input !== "string" || input.trim().length === 0) {
            return {
              content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
              details: { mode: "auth-complete", error: "missing_input" },
            };
          }
          return heavy.proxyModes.executeAuthComplete(currentState, params.server, input);
        }
        if (params.tool) {
          return heavy.proxyModes.executeCall(currentState, params.tool, parsedArgs, params.server, getPiTools, signal);
        }
        if (params.connect) {
          return heavy.proxyModes.executeConnect(currentState, params.connect, signal);
        }
        if (params.describe) {
          return heavy.proxyModes.executeDescribe(currentState, params.describe);
        }
        if (params.search) {
          return heavy.proxyModes.executeSearch(currentState, params.search, params.regex, params.server, params.includeSchemas);
        }
        if (params.server) {
          return heavy.proxyModes.executeList(currentState, params.server);
        }
        return heavy.proxyModes.executeStatus(currentState);
      },
    });
  }
}
