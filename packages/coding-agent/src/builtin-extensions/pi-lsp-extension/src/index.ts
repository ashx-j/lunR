// @ts-nocheck
/**
 * pi-lsp-extension — Pi coding agent extension for LSP integration.
 *
 * Exposes Language Server Protocol capabilities as tools the LLM can call:
 * - lsp_diagnostics: compilation errors and warnings
 * - lsp_hover: type info and docs at a position
 * - lsp_definition: go to definition
 * - lsp_references: find all references
 * - lsp_symbols: file/workspace symbol search
 * - lsp_rename: preview rename refactoring
 * - lsp_completions: code completion suggestions at a position
 * - lsp_code_actions: quick fixes, refactorings, and source actions
 *
 * Position-based tools (hover, definition, references, rename, code_actions)
 * accept an optional `query` parameter as an alternative to line/character,
 * resolving a symbol name to its position automatically.
 *
 * Tool schemas, commands, and hooks register immediately. Heavy managers
 * (LspManager, FileSync, Tree-sitter/WASM, WorkspaceIndex) load on first use.
 *
 * Usage:
 *   1. npm install in this directory
 *   2. Add to pi via settings.json extensions, or: pi -e ./src/index.ts
 *   3. LSP servers start lazily when you first use a tool on a file
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { awaitWithAbort } from "../../../utils/await-with-abort.ts";
import {
  isReadToolResult,
  isWriteToolResult,
  isEditToolResult,
} from "../../../core/extensions/types.js";
import { DiagnosticSeverity } from "vscode-languageserver-protocol";

import type { WorkspaceProvider } from "./workspace-provider.js";
import { LspRuntimeHost, type LspRuntimeCallbacks } from "./runtime.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createHoverTool } from "./tools/hover.js";
import { createDefinitionTool } from "./tools/definition.js";
import { createReferencesTool } from "./tools/references.js";
import { createSymbolsTool } from "./tools/symbols.js";
import { createRenameTool } from "./tools/rename.js";
import { createCodeOverviewTool } from "./tools/code-overview.js";
import { createCompletionsTool } from "./tools/completions.js";
import { createCodeSearchTool } from "./tools/code-search.js";
import { createCodeRewriteTool } from "./tools/code-rewrite.js";
import { createCodeActionsTool } from "./tools/code-actions.js";
import { syntheticDotLocks } from "./tools/completions.js";
import { relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIAGNOSTIC_SETTLE_DELAY_MS } from "./shared/timing.js";

/**
 * Project-level LSP config — loaded from `.pi-lsp.json` in the workspace root.
 *
 * Example:
 * ```json
 * {
 *   "autoStart": ["java", "typescript"],
 *   "lombokJar": "env/Lombok-1.18.x/runtime/lib/lombok-1.18.42.jar",
 *   "servers": {
 *     "python": { "command": "pylsp", "args": [] }
 *   }
 * }
 * ```
 */
interface ProjectLspConfig {
  /** Languages to start eagerly on session_start (e.g. ["java", "typescript"]) */
  autoStart?: string[];
  /** Path to Lombok jar (absolute or relative to project root). "auto" to auto-detect. */
  lombokJar?: string;
  /** Custom server configs keyed by language ID */
  servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; initializationOptions?: Record<string, unknown>; settings?: Record<string, unknown> }>;
  /**
   * Auto-inject LSP error diagnostics into write/edit tool results.
   * Set to false to disable, or provide an array of language IDs to enable selectively.
   * Default: true (all languages).
   *
   * Examples:
   *   true              — inject for all languages
   *   false             — never inject
   *   ["typescript"]    — only inject for TypeScript files
   */
  autoInjectDiagnostics?: boolean | string[];
}

interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

/** Load .pi-lsp.json from a directory. Returns null if not found or invalid. */
function loadProjectConfig(dir: string): ProjectLspConfig | null {
  const configPath = join(dir, ".pi-lsp.json");
  try {
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ProjectLspConfig;
  } catch {
    return null;
  }
}

function createServiceProxy<T extends object>(getTarget: () => T | null, label: string): T {
  return new Proxy({} as T, {
    get(_target, prop, receiver) {
      const service = getTarget();
      if (!service) {
        throw new Error(`${label} is not initialized`);
      }
      const value = Reflect.get(service, prop, service);
      if (typeof value === "function") {
        return value.bind(service);
      }
      return value;
    },
  });
}

function registerToolWithRuntime<T extends TSchema, D>(pi: ExtensionAPI, tool: ToolDefinition<T, D>, ensure: () => Promise<unknown>, host: LspRuntimeHost) {
  pi.registerTool({
    ...tool,
    async execute(id, params, signal, onUpdate, ctx) {
      const generation = host.getGeneration();
      signal?.throwIfAborted();
      await awaitWithAbort(ensure(), signal);
      signal?.throwIfAborted();
      if (host.getGeneration() !== generation) throw new Error("LSP session changed before execution");
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });
}

export default function lspExtension(pi: ExtensionAPI) {
  // Prevent EPIPE errors from LSP server exits from crashing the host process.
  // When an LSP server exits unexpectedly, in-flight writes to its stdin pipe
  // can produce EPIPE errors that escape all connection-level error handlers.
  const origListeners = process.listeners("uncaughtException");
  process.on("uncaughtException", (err: any) => {
    if (err?.code === "EPIPE") return; // swallow — LSP server exited, harmless
    // Re-throw for other handlers
    for (const listener of origListeners) (listener as any)(err);
    if (origListeners.length === 0) {
      console.error("[LSP] Uncaught exception:", err);
    }
  });

  const host = new LspRuntimeHost();
  let pendingProvider: WorkspaceProvider | null = null;
  let latestCtx: any = null;
  let projectConfig: ProjectLspConfig | null = null;
  let sessionCwd = process.cwd();

  /**
   * Run `fn` with the currently captured ctx, swallowing stale-ctx errors.
   *
   * Lifecycle callbacks from LspManager (server ready, workspace setup, etc.)
   * and `pi.events` listeners can fire AFTER the session is replaced or reloaded,
   * at which point the captured ctx has been invalidated and any property access
   * throws via ExtensionRunner.assertActive(). We can't use optional chaining to
   * dodge it because the `ui` / `theme` getters themselves run assertActive().
   */
  const withLatestCtx = (fn: (ctx: any) => void) => {
    const ctx = latestCtx;
    if (!ctx) return;
    try {
      fn(ctx);
    } catch (err: any) {
      if (typeof err?.message === "string" && err.message.includes("stale after session")) {
        // Session was replaced/reloaded — drop the stale ctx and move on.
        latestCtx = null;
        return;
      }
      throw err;
    }
  };

  const applyProvider = (data: unknown) => {
    const provider = data as WorkspaceProvider;
    pendingProvider = provider;
    host.setPendingProvider(provider);
    const statusText = provider.getStatusText();
    if (!statusText) return;
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    });
  };

  pi.events.on("lsp:register-workspace-provider", applyProvider);

  // Check for provider registered before our listener existed
  const existing = (pi.events as any)["lsp:workspace-provider"];
  if (existing) applyProvider(existing);

  const setLspStatus = (color: string, text: string) => {
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg(color, text));
    });
  };

  const makeCallbacks = (): LspRuntimeCallbacks => ({
    onWorkspaceSetupStart: () => {
      setLspStatus("warning", "LSP: workspace setup...");
    },
    onWorkspaceSetupEnd: (success: boolean, duration: number) => {
      const secs = (duration / 1000).toFixed(1);
      if (success) {
        setLspStatus("accent", `LSP: workspace ready (${secs}s)`);
      } else {
        setLspStatus("warning", `LSP: workspace setup failed (${secs}s)`);
      }
    },
    onServerStart: (languageId: string, command: string) => {
      setLspStatus("warning", `LSP: starting ${languageId} (${command})...`);
    },
    onServerReady: (languageId: string) => {
      setLspStatus("accent", `LSP: ${languageId} ready`);
    },
    onServerError: (languageId: string, _error: string) => {
      setLspStatus("error", `LSP: ${languageId} failed`);
    },
    onServerCrash: (languageId: string, restarting: boolean, attempt: number) => {
      if (restarting) {
        setLspStatus("warning", `LSP: restarting ${languageId}... (attempt ${attempt}/3)`);
      } else {
        setLspStatus("error", `LSP: ${languageId} crashed — auto-restart exhausted`);
      }
    },
  });

  const applyProjectConfigToManager = (manager: { setServerConfig: Function; setLombokJar: Function }, config: ProjectLspConfig | null) => {
    if (!config) return;
    if (config.servers) {
      for (const [lang, serverConf] of Object.entries(config.servers)) {
        manager.setServerConfig(lang, {
          command: serverConf.command,
          args: serverConf.args ?? [],
          env: serverConf.env,
          initializationOptions: serverConf.initializationOptions,
          settings: serverConf.settings,
        });
      }
    }
    if (config.lombokJar && config.lombokJar !== "auto") {
      manager.setLombokJar(config.lombokJar);
    }
  };

  const buildBindOptions = (cwd: string) => ({
    cwd,
    callbacks: makeCallbacks(),
    pendingProvider,
    syntheticDotChecker: (uri: string) => syntheticDotLocks.has(uri),
    configureManager: (manager) => {
      applyProjectConfigToManager(manager, projectConfig);
    },
  });

  const ensureRuntime = async () => {
    return host.ensureServices(
      buildBindOptions(sessionCwd || process.cwd()),
    );
  };

  // session_start binds cwd/config only. Heavy managers load on first use,
  // unless autoStart is configured (then ensure + startEagerly).
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    sessionCwd = ctx.cwd;

    projectConfig = loadProjectConfig(ctx.cwd);
    await host.bindSession(buildBindOptions(ctx.cwd));

    const statusText = pendingProvider?.getStatusText?.() ?? "";
    if (statusText) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    } else {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    }

    if (projectConfig?.autoStart && projectConfig.autoStart.length > 0) {
      const langs = projectConfig.autoStart;
      const generation = host.getGeneration();
      void ensureRuntime().then((services) => {
        if (host.getGeneration() !== generation) return;
        const lombokJar = services.manager.getLombokJar?.() ?? null;
        const lombokNote = langs.includes("java") && lombokJar
          ? ` (lombok: ${String(lombokJar).split(/[/\\]/).pop()})`
          : "";
        setLspStatus("warning", `LSP: auto-starting ${langs.join(", ")}${lombokNote}...`);
        services.manager.startEagerly(langs);
      }).catch((error) => {
        if (host.getGeneration() === generation) setLspStatus("error", `LSP startup failed: ${String(error)}`);
      });
    }
  });

  const managerProxy = createServiceProxy(
    () => host.getServicesIfReady()?.manager ?? null,
    "LSP manager",
  );
  const treeSitterProxy = createServiceProxy(
    () => host.getServicesIfReady()?.treeSitter ?? null,
    "Tree-sitter manager",
  );
  const workspaceIndexProxy = createServiceProxy(
    () => host.getServicesIfReady()?.workspaceIndex ?? null,
    "Workspace index",
  );

  registerToolWithRuntime(pi, createDiagnosticsTool(managerProxy, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createHoverTool(managerProxy, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createDefinitionTool(managerProxy, treeSitterProxy, workspaceIndexProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createReferencesTool(managerProxy, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createSymbolsTool(managerProxy, treeSitterProxy, workspaceIndexProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createRenameTool(managerProxy, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createCodeActionsTool(managerProxy, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createCompletionsTool(
      managerProxy,
      {
        getTrackedVersion: (uri) => {
          const services = host.getServicesIfReady();
          if (!services) return null;
          return services.fileSync.getTrackedVersion(uri);
        },
        setTrackedVersion: (uri, v) => {
          host.getServicesIfReady()?.fileSync.setTrackedVersion(uri, v);
        },
        isSyntheticDotActive: (uri) => syntheticDotLocks.has(uri),
      },
      treeSitterProxy,
    ), ensureRuntime, host);
  const getRootDir = () => {
    const manager = host.getServicesIfReady()?.manager;
    if (manager) return manager.resolvePath(".");
    return sessionCwd || process.cwd();
  };
  registerToolWithRuntime(pi, createCodeOverviewTool(getRootDir, treeSitterProxy, workspaceIndexProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createCodeSearchTool(getRootDir, treeSitterProxy), ensureRuntime, host);
  registerToolWithRuntime(pi, createCodeRewriteTool(getRootDir, treeSitterProxy, {
      onFileModified: (filePath: string) => {
        const services = host.getServicesIfReady();
        if (!services) return;
        services.fileSync.handleFileWrite(filePath).catch(() => {});
      },
    }), ensureRuntime, host);

  // File sync: track file reads/writes/edits without loading runtime on plain reads
  // when LSP was never used. Writes may start a server (existing behavior) so they
  // ensure runtime. After writes/edits, append file-scoped error diagnostics.
  pi.on("tool_result", async (event) => {
    const generation = host.getGeneration();
    try {
      if (isReadToolResult(event) && !event.isError) {
        const services = host.getServicesIfReady();
        if (services) {
          const path = (event.input as any)?.path;
          if (path) await services.fileSync.handleFileRead(path);
          if (host.getGeneration() !== generation) return;
        }
      }

      if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) {
          const services = await ensureRuntime();
          if (host.getGeneration() !== generation) return;
          await services.fileSync.handleFileWrite(path);
        }
      }
    } catch {
      // File sync errors are non-fatal
    }

    if (host.getGeneration() !== generation) return;
    // Auto-append diagnostics for the changed file (write/edit only)
    const services = host.getServicesIfReady();
    if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError && services) {
      const path = (event.input as any)?.path;
      if (!path) return;

      const manager = services.manager;
      const languageId = manager.getLanguageId(path);
      if (!languageId) return;

      // Check autoInjectDiagnostics config
      const inject = projectConfig?.autoInjectDiagnostics;
      if (inject === false) return;
      if (Array.isArray(inject) && !inject.includes(languageId)) return;

      const client = manager.getRunningClient(languageId);
      if (!client) return;

      // Wait briefly for the LSP to publish updated diagnostics
      await new Promise((r) => setTimeout(r, DIAGNOSTIC_SETTLE_DELAY_MS));
      if (host.getGeneration() !== generation) return;

      const uri = manager.getFileUri(path);
      const diagnostics = client.getDiagnostics(uri);
      const errors = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);

      if (errors.length === 0) return;

      // Build a compact summary — just errors, max 10 lines
      const relPath = relative(manager.resolvePath("."), manager.resolvePath(path));
      const lines = errors.slice(0, 10).map((d) => {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const source = d.source ? ` [${d.source}]` : "";
        return `${relPath}:${line}:${col} error: ${d.message}${source}`;
      });
      if (errors.length > 10) {
        lines.push(`... and ${errors.length - 10} more error(s)`);
      }

      const summary = `\n\n⚠ LSP: ${errors.length} error(s) in ${relPath}:\n${lines.join("\n")}`;

      return {
        content: [
          ...event.content,
          { type: "text" as const, text: summary },
        ],
      };
    }
  });

  // Update status after tool execution ends
  pi.on("tool_execution_end", async (_event, ctx) => {
    latestCtx = ctx;
    const services = host.getServicesIfReady();
    if (!services) return;
    const statuses = services.manager.getStatus();
    const running = statuses.filter((s) => s.running);
    if (running.length === 0) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    } else {
      const totalDiags = running.reduce((n, s) => n + s.diagnosticsCount, 0);
      const langs = running.map((s) => s.languageId).join(", ");
      let status = `LSP: ${langs}`;
      if (totalDiags > 0) {
        status += ` (${totalDiags} diagnostic${totalDiags !== 1 ? "s" : ""})`;
      }
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", status));
    }
  });

  // /lsp command — show server status
  pi.registerCommand("lsp", {
    description: "Show LSP server status",
    handler: async (_args, ctx) => {
      const services = host.getServicesIfReady();
      if (!services) {
        ctx.ui.notify(
          host.isInitializing() ? "LSP runtime is starting" : "LSP runtime is idle (not started)",
          "info",
        );
        return;
      }

      const statuses = services.manager.getStatus();
      if (statuses.length === 0) {
        ctx.ui.notify("No LSP servers configured", "info");
        return;
      }

      const lines = statuses.map((s) => {
        const icon = s.running ? "🟢" : "⚪";
        const diags =
          s.diagnosticsCount > 0 ? ` (${s.diagnosticsCount} diagnostics)` : "";
        const shared = s.shared ? " [shared]" : "";
        return `${icon} ${s.languageId}: ${s.command}${diags}${shared}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /lsp-restart command — restart a specific language server
  pi.registerCommand("lsp-restart", {
    description: "Restart an LSP server: /lsp-restart <language> (e.g. java, typescript)",
    handler: async (args, ctx) => {
      const services = host.getServicesIfReady();
      if (!services) {
        if (args?.trim()) {
          ctx.ui.notify(
            host.isInitializing()
              ? "LSP runtime is starting"
              : "LSP runtime is idle. Run an LSP tool before restarting a server.",
            "info",
          );
        } else {
          ctx.ui.notify("No LSP servers are running.\n\nUsage: /lsp-restart <language>", "info");
        }
        return;
      }

      const languageId = args?.trim().toLowerCase();
      if (!languageId) {
        // Show running servers and usage
        const statuses = services.manager.getStatus().filter((s) => s.running);
        if (statuses.length === 0) {
          ctx.ui.notify("No LSP servers are running.\n\nUsage: /lsp-restart <language>", "info");
        } else {
          const langs = statuses.map((s) => s.languageId).join(", ");
          ctx.ui.notify(
            `Running servers: ${langs}\n\nUsage: /lsp-restart <language>\nExample: /lsp-restart java`,
            "info"
          );
        }
        return;
      }

      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("warning", `LSP: restarting ${languageId}...`));
      ctx.ui.notify(`Restarting ${languageId} server (kills daemon if shared)...`, "info");

      try {
        await services.manager.restartServer(languageId);
        const lombokJar = languageId === "java" ? services.manager.getLombokJar() : null;
        const lombokNote = lombokJar ? `\nLombok: ${lombokJar}` : "";
        ctx.ui.notify(`${languageId} server restarted successfully.${lombokNote}`, "info");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${languageId} ready`));
      } catch (err: any) {
        ctx.ui.notify(`Failed to restart ${languageId}: ${err.message}`, "error");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("error", `LSP: ${languageId} restart failed`));
      }
    },
  });

  // /lsp-config command — add or override server configuration
  pi.registerCommand("lsp-config", {
    description:
      "Configure an LSP server: /lsp-config <language> <command> [args...]",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]\nExample: /lsp-config python pylsp",
          "info"
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]",
          "warning"
        );
        return;
      }

      const [languageId, command, ...serverArgs] = parts;
      const config: ServerConfig = { command, args: serverArgs };

      const services = await ensureRuntime();
      services.manager.setServerConfig(languageId, config);
      ctx.ui.notify(
        `Configured LSP for ${languageId}: ${command} ${serverArgs.join(" ")}`,
        "info"
      );
    },
  });

  // /lsp-lombok command — set Lombok jar path for Java
  pi.registerCommand("lsp-lombok", {
    description:
      "Set Lombok jar path for Java: /lsp-lombok <path-to-lombok.jar>",
    handler: async (args, ctx) => {
      const services = await ensureRuntime();
      const mgr = services.manager;

      if (!args?.trim()) {
        const current = mgr.getLombokJar();
        if (current) {
          ctx.ui.notify(`Lombok jar: ${current}`, "info");
        } else {
          ctx.ui.notify(
            "No Lombok jar configured or detected.\n\n" +
            "Usage: /lsp-lombok <path-to-lombok.jar>\n" +
            "Or set LOMBOK_JAR environment variable.\n\n" +
            "Download from: https://projectlombok.org/download",
            "info"
          );
        }
        return;
      }

      const jarPath = args.trim();
      const resolved = resolve(ctx.cwd, jarPath);

      if (!existsSync(resolved)) {
        ctx.ui.notify(`File not found: ${resolved}`, "error");
        return;
      }

      if (!resolved.endsWith(".jar")) {
        ctx.ui.notify(`Warning: ${resolved} doesn't end in .jar — setting anyway`, "warning");
      }

      mgr.setLombokJar(resolved);
      ctx.ui.notify(`Lombok jar set: ${resolved}`, "info");
    },
  });

  // Clean shutdown — never loads heavy modules if they were unused
  pi.on("session_shutdown", async () => {
    // Drop the captured ctx immediately — once shutdown fires, any late
    // LSP manager callback that reaches setLspStatus/applyProvider would
    // otherwise hit an invalidated ctx and throw an uncaught exception.
    latestCtx = null;
    await host.shutdown();
  });
}

export { LspRuntimeHost } from "./runtime.js";
