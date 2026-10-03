// @ts-nocheck
/**
 * LSP Client — JSON-RPC client for LSP servers.
 *
 * Supports two modes:
 * - **Direct**: spawns LSP server as child process (stdio)
 * - **Socket**: connects to an LSP daemon via Unix domain socket
 *
 * Uses vscode-jsonrpc (bundled with vscode-languageserver-protocol) for
 * JSON-RPC message framing and transport.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  SocketMessageReader,
  SocketMessageWriter,
  type MessageConnection,
} from "vscode-languageserver-protocol/node";
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  Diagnostic,
  PublishDiagnosticsParams,
} from "vscode-languageserver-protocol";

export interface LspClientOptions {
  /** Command to start the LSP server */
  command: string;
  /** Arguments for the command */
  args: string[];
  /** Root directory of the workspace */
  rootDir: string;
  /** Language ID this server handles */
  languageId: string;
  /** Extra environment variables */
  env?: Record<string, string>;
  /** Additional workspace folders (e.g. for multi-package workspaces) */
  workspaceFolders?: { uri: string; name: string }[];
  /** Connect to existing daemon socket instead of spawning a new process */
  socketPath?: string;
  /** LSP initializationOptions (e.g. jdtls settings for Lombok) */
  initializationOptions?: Record<string, unknown>;
  /** Settings returned by workspace/configuration handler (keyed by section, e.g. { intelephense: {...} }) */
  settings?: Record<string, unknown>;
  /** Called when the server exits unexpectedly (not from user-initiated shutdown) */
  onUnexpectedExit?: (code: number | null) => void;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private socket: Socket | null = null;
  private connection: MessageConnection | null = null;
  private _serverCapabilities: ServerCapabilities | null = null;
  private _diagnostics: Map<string, Diagnostic[]> = new Map();
  private _initialized = false;
  private _disposed = false;
  /** True if connected to a daemon socket (server init handled by daemon) */
  private _isDaemonClient = false;

  private readonly stop = new AbortController();
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  readonly languageId: string;
  readonly command: string;
  readonly rootDir: string;

  constructor(private options: LspClientOptions) {
    this.languageId = options.languageId;
    this.command = options.command;
    this.rootDir = options.rootDir;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get serverCapabilities(): ServerCapabilities | null {
    return this._serverCapabilities;
  }

  /** Get cached diagnostics for a URI */
  getDiagnostics(uri: string): Diagnostic[] {
    return this._diagnostics.get(uri) ?? [];
  }

  /** Get all cached diagnostics */
  getAllDiagnostics(): Map<string, Diagnostic[]> {
    return new Map(this._diagnostics);
  }

  /** Start the LSP server and perform the initialize handshake */
  start(): Promise<void> {
    if (this._disposed) return Promise.reject(new Error("LSP client shut down"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = (this.options.socketPath
      ? this.connectToSocket(this.options.socketPath)
      : this.spawnDirect()).catch(async (error: unknown) => {
        await this.shutdown();
        throw error;
      });
    return this.startPromise;
  }

  /** Cancel an owned handshake without waiting for the remote server. */
  private waitForStart<T>(pending: Promise<T>): Promise<T> {
    const signal = this.stop.signal;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  /** Register shared connection handlers (diagnostics, workspace/configuration, errors) */
  private registerConnectionHandlers(): void {
    if (!this.connection) return;

    // Listen for published diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        this._diagnostics.set(params.uri, params.diagnostics);
      }
    );

    // Handle workspace/configuration requests from the server.
    // Servers like Intelephense request their settings via this method.
    // Return settings from options if configured, otherwise empty defaults.
    this.connection.onRequest(
      "workspace/configuration",
      (params: { items: { section?: string }[] }) => {
        const settings = this.options.settings;
        return params.items.map((item) => {
          if (item.section && settings && item.section in settings) {
            return settings[item.section];
          }
          return {};
        });
      }
    );

    // Handle connection-level errors to prevent unhandled exceptions
    this.connection.onError(([err]) => {
      console.error(`[LSP ${this.languageId}] Connection error: ${err.message}`);
    });

    this.connection.onClose(() => {
      if (!this._disposed) {
        this._initialized = false;
      }
    });
  }

  /** Connect to an existing LSP daemon via Unix socket (no init handshake needed) */
  private async connectToSocket(socketPath: string): Promise<void> {
    this._isDaemonClient = true;

    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let timeout: ReturnType<typeof setTimeout>;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.stop.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => {
        settle(new Error("LSP client shut down"));
        socket.destroy();
      };
      const socket = netConnect(socketPath, () => {
        if (this._disposed || settled) { socket.destroy(); return; }
        try {
          const reader = new SocketMessageReader(socket);
          const writer = new SocketMessageWriter(socket);
          this.connection = createMessageConnection(reader, writer);
          this.registerConnectionHandlers();
          this.connection.listen();
          this._initialized = true;
          connected = true;
          settle();
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
          socket.destroy();
        }
      });
      // Capture even a connecting socket so shutdown can close it.
      this.socket = socket;
      socket.on("error", (err) => {
        settle(new Error(`Failed to connect to LSP daemon: ${err.message}`));
        this._initialized = false;
      });
      socket.on("close", () => {
        settle(new Error("LSP daemon socket closed during startup"));
        if (!this._disposed) {
          this._initialized = false;
          if (connected) this.options.onUnexpectedExit?.(null);
        }
      });
      timeout = setTimeout(() => {
        settle(new Error("Timeout connecting to LSP daemon socket"));
        socket.destroy();
      }, 10_000);
      this.stop.signal.addEventListener("abort", aborted, { once: true });
      if (this.stop.signal.aborted) aborted();
    });
  }

  /** Spawn LSP server directly as child process with stdio */
  private async spawnDirect(): Promise<void> {
    const env = { ...process.env, ...this.options.env };

    this.process = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: this.rootDir,
    });

    const child = this.process;
    // Error listeners belong to this child and its streams, never the host process.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", (err: Error) => {
        if (!this._disposed) console.error(`[LSP ${this.languageId}] Transport error: ${err.message}`);
      });
    }
    child.on("error", (err) => {
      if (!this._disposed) console.error(`[LSP ${this.languageId}] Process error: ${err.message}`);
      this._initialized = false;
      this.disposeConnection();
    });
    let wasInitialized = false;
    child.on("exit", (code) => {
      if (!this._disposed) {
        this._initialized = false;
        this.disposeConnection();
        // A failed handshake is handled by the pending start, not auto-restart.
        if (wasInitialized) this.options.onUnexpectedExit?.(code);
      }
    });
    if (!child.stdout || !child.stdin) {
      throw new Error(`Failed to spawn LSP server: ${this.options.command}`);
    }

    await this.waitForStart(new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn LSP server "${this.options.command}": ${err.message}`));
      };
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        this.stop.signal.removeEventListener("abort", cleanup);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
      this.stop.signal.addEventListener("abort", cleanup, { once: true });
    }));
    this.stop.signal.throwIfAborted();
    child.stderr?.resume();

    const reader = new StreamMessageReader(child.stdout);
    const writer = new StreamMessageWriter(child.stdin);
    this.connection = createMessageConnection(reader, writer);

    this.registerConnectionHandlers();

    this.connection.listen();

    // Initialize handshake
    const rootUri = pathToFileURL(this.rootDir).toString();
    const defaultFolder = { uri: rootUri, name: this.rootDir.split("/").pop() ?? "workspace" };

    // Use provided workspace folders or fall back to single root
    const workspaceFolders = this.options.workspaceFolders && this.options.workspaceFolders.length > 0
      ? this.options.workspaceFolders
      : [defaultFolder];

    const initParams: InitializeParams = {
      processId: process.pid,
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            dynamicRegistration: false,
          },
          hover: {
            contentFormat: ["plaintext", "markdown"],
          },
          definition: {},
          references: {},
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true,
          },
          rename: {
            prepareSupport: false,
          },
          publishDiagnostics: {
            relatedInformation: true,
          },
          completion: {
            completionItem: {
              snippetSupport: false,
            },
          },
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
          configuration: true,
        },
      },
      rootUri,
      workspaceFolders,
      ...(this.options.initializationOptions
        ? { initializationOptions: this.options.initializationOptions }
        : {}),
    };

    const result: InitializeResult = await this.waitForStart(this.connection.sendRequest(
      "initialize",
      initParams
    ));
    this.stop.signal.throwIfAborted();
    this._serverCapabilities = result.capabilities;

    // Send initialized notification
    await this.waitForStart(this.connection.sendNotification("initialized", {}));
    this.stop.signal.throwIfAborted();
    this._initialized = true;
    wasInitialized = true;
  }

  /** Safely dispose the connection without throwing */
  private disposeConnection(): void {
    try {
      if (this.connection) {
        this.connection.dispose();
      }
    } catch {
      // Already disposed or stream destroyed — ignore
    }
    this.connection = null;
  }

  /** Send a request to the LSP server */
  async sendRequest<R>(method: string, params: unknown): Promise<R> {
    if (!this.connection || !this._initialized) {
      throw new Error(`LSP ${this.languageId} not initialized`);
    }
    return this.connection.sendRequest(method, params) as Promise<R>;
  }

  /** Send a notification to the LSP server */
  sendNotification(method: string, params: unknown): void {
    if (!this.connection || !this._initialized) return;
    const report = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!this._disposed) console.error(`[LSP ${this.languageId}] Notification failed: ${message}`);
    };
    try {
      void this.connection.sendNotification(method, params).catch(report);
    } catch (error) {
      report(error);
    }
  }

  /** Notify server of a newly opened document */
  didOpen(uri: string, languageId: string, version: number, text: string): void {
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  /** Notify server of a document change (full content sync) */
  didChange(uri: string, version: number, text: string): void {
    this.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Notify server of a closed document */
  didClose(uri: string): void {
    this.sendNotification("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  /** Gracefully shut down or disconnect from the server */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const initialized = this._initialized;
    this._disposed = true;
    this._initialized = false;
    this.stop.abort(new Error("LSP client shut down"));
    this.shutdownPromise = this.shutdownOwnedTransport(initialized);
    return this.shutdownPromise;
  }

  private async shutdownOwnedTransport(initialized: boolean): Promise<void> {
    const child = this.process;
    const connection = this.connection;
    this.process = null;
    if (this._isDaemonClient) {
      // Shared daemon ownership ends at this session's socket.
      this.disposeConnection();
      this.socket?.destroy();
      this.socket = null;
      return;
    }

    if (connection && initialized) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const graceful = async () => {
          await connection.sendRequest("shutdown").catch(() => {});
          await connection.sendNotification("exit").catch(() => {});
        };
        await Promise.race([
          graceful().catch(() => {}),
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, 3000); }),
        ]);
      } catch {
        // The owned transport may have closed during shutdown.
      } finally {
        clearTimeout(timeout);
      }
    }
    this.disposeConnection();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    // Signal delivery does not mean exit. Keep the captured child through escalation.
    await new Promise<void>((resolve, reject) => {
      let forceTimer: ReturnType<typeof setTimeout>;
      let exitTimer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(forceTimer);
        clearTimeout(exitTimer);
        child.removeListener("exit", exited);
      };
      const exited = () => { cleanup(); resolve(); };
      const signalChild = (signal: NodeJS.Signals) => {
        try { child.kill(signal); }
        catch (error) { cleanup(); reject(error); }
      };
      child.once("exit", exited);
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) { exited(); return; }
        exitTimer = setTimeout(() => {
          cleanup();
          reject(new Error(`LSP ${this.languageId} process did not exit after SIGKILL`));
        }, 1000);
        signalChild("SIGKILL");
      }, 2000);
      signalChild("SIGTERM");
    });
  }
}
