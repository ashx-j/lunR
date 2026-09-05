// @ts-nocheck
/**
 * Lazy LSP runtime host.
 *
 * Session bind, tool schema registration, and commands stay cheap.
 * LspManager / FileSync / Tree-sitter / WorkspaceIndex load on first use,
 * share one in-flight init, drop stale loads after reload/shutdown, and
 * allow retry after a rejected load. Shutdown of a never-used host does
 * not import heavy modules.
 */

import type { WorkspaceProvider } from "./workspace-provider.js";

/** Minimal callback surface mirrored from LspManager (avoids static import). */
export interface LspRuntimeCallbacks {
  onWorkspaceSetupStart?: () => void;
  onWorkspaceSetupEnd?: (success: boolean, duration: number) => void;
  onServerStart?: (languageId: string, command: string) => void;
  onServerReady?: (languageId: string) => void;
  onServerError?: (languageId: string, error: string) => void;
  onServerCrash?: (languageId: string, restarting: boolean, attempt: number) => void;
}

export interface LspRuntimeServices {
  manager: {
    setWorkspaceProvider(provider: WorkspaceProvider): void;
    setServerConfig(languageId: string, config: unknown): void;
    setLombokJar(path: string): void;
    getLombokJar(): string | null;
    startEagerly(languages: string[]): void;
    shutdownAll(): Promise<void>;
    getStatus(): Array<{
      languageId: string;
      command: string;
      running: boolean;
      diagnosticsCount: number;
      shared: boolean;
    }>;
    getLanguageId(filePath: string): string | undefined;
    getFileUri(filePath: string): string;
    resolvePath(filePath: string): string;
    getRunningClient(languageId: string): { getDiagnostics(uri: string): Array<{ severity?: number; range: { start: { line: number; character: number } }; message: string; source?: string }> } | undefined;
    restartServer(languageId: string): Promise<void>;
    [key: string]: unknown;
  };
  fileSync: {
    handleFileRead(filePath: string): Promise<void>;
    handleFileWrite(filePath: string): Promise<void>;
    getTrackedVersion(uri: string): number | null;
    setTrackedVersion(uri: string, version: number): void;
    setSyntheticDotChecker(checker: (uri: string) => boolean): void;
    setTreeSitter(treeSitter: unknown, workspaceIndex?: unknown): void;
    [key: string]: unknown;
  };
  treeSitter: {
    init(): Promise<void>;
    shutdown(): void;
    [key: string]: unknown;
  };
  workspaceIndex: {
    [key: string]: unknown;
  };
}

export interface LspRuntimeBindOptions {
  cwd: string;
  callbacks: LspRuntimeCallbacks;
  pendingProvider?: WorkspaceProvider | null;
  syntheticDotChecker: (uri: string) => boolean;
  /** Apply project server configs / lombok after manager construction. */
  configureManager?: (manager: LspRuntimeServices["manager"]) => void;
}

export interface LspRuntimeModuleLoaders {
  loadLspManager?: () => Promise<{ LspManager: new (...args: never[]) => LspRuntimeServices["manager"] }>;
  loadFileSync?: () => Promise<{ FileSync: new (...args: never[]) => LspRuntimeServices["fileSync"] }>;
  loadTreeSitter?: () => Promise<{ TreeSitterManager: new (...args: never[]) => LspRuntimeServices["treeSitter"] }>;
  loadWorkspaceIndex?: () => Promise<{
    WorkspaceIndex: new (...args: never[]) => LspRuntimeServices["workspaceIndex"];
  }>;
}

const defaultLoaders: Required<LspRuntimeModuleLoaders> = {
  loadLspManager: () => import("./lsp-manager.js"),
  loadFileSync: () => import("./file-sync.js"),
  loadTreeSitter: () => import("./tree-sitter/parser-manager.js"),
  loadWorkspaceIndex: () => import("./tree-sitter/workspace-index.js"),
};

export class LspRuntimeHost {
  private generation = 0;
  private services: LspRuntimeServices | null = null;
  private initPromise: Promise<LspRuntimeServices> | null = null;
  private bindOptions: LspRuntimeBindOptions | null = null;
  private readonly loaders: Required<LspRuntimeModuleLoaders>;

  constructor(loaders?: LspRuntimeModuleLoaders) {
    this.loaders = { ...defaultLoaders, ...loaders };
  }

  /** Current bind generation — bumped on every bind/shutdown. */
  getGeneration(): number {
    return this.generation;
  }

  /** True only after a successful ensureServices for the current generation. */
  hasServices(): boolean {
    return this.services !== null;
  }

  getServicesIfReady(): LspRuntimeServices | null {
    return this.services;
  }

  getBindOptions(): LspRuntimeBindOptions | null {
    return this.bindOptions;
  }

  /**
   * Bind session cwd/callbacks without loading heavy modules.
   * Invalidates any in-flight or completed runtime from a prior session.
   */
  bindSession(options: LspRuntimeBindOptions): void {
    this.generation += 1;
    const previous = this.services;
    this.services = null;
    this.initPromise = null;
    this.bindOptions = options;
    if (previous) {
      void this.shutdownServices(previous);
    }
  }

  /** Keep live manager/provider in sync when a provider arrives after bind. */
  setPendingProvider(provider: WorkspaceProvider | null): void {
    if (this.bindOptions) {
      this.bindOptions = { ...this.bindOptions, pendingProvider: provider };
    }
    const services = this.services;
    if (services && provider) {
      services.manager.setWorkspaceProvider(provider);
    }
  }

  /**
   * Load and construct heavy managers once per generation.
   * Concurrent callers share the same promise. Rejected loads clear the
   * in-flight promise so a later call can recover.
   */
  async ensureServices(fallbackOptions?: LspRuntimeBindOptions): Promise<LspRuntimeServices> {
    if (this.services) return this.services;
    if (this.initPromise) return this.initPromise;

    if (!this.bindOptions) {
      if (!fallbackOptions) {
        throw new Error("LSP runtime is not bound to a session");
      }
      this.bindOptions = fallbackOptions;
    }

    const gen = this.generation;
    const options = this.bindOptions;
    const pending = this.loadServices(gen, options);
    this.initPromise = pending;

    try {
      const services = await pending;
      return services;
    } catch (err) {
      if (this.generation === gen && this.initPromise === pending) {
        this.initPromise = null;
      }
      throw err;
    }
  }

  /**
   * Shut down without importing heavy modules when they were never loaded.
   * Bumps generation so in-flight loads cannot attach afterward.
   */
  async shutdown(): Promise<void> {
    this.generation += 1;
    const previous = this.services;
    this.services = null;
    this.initPromise = null;
    this.bindOptions = null;
    if (previous) {
      await this.shutdownServices(previous);
    }
  }

  private async loadServices(
    gen: number,
    options: LspRuntimeBindOptions,
  ): Promise<LspRuntimeServices> {
    const [managerMod, fileSyncMod, treeSitterMod, workspaceIndexMod] = await Promise.all([
      this.loaders.loadLspManager(),
      this.loaders.loadFileSync(),
      this.loaders.loadTreeSitter(),
      this.loaders.loadWorkspaceIndex(),
    ]);

    if (gen !== this.generation) {
      throw new Error("LSP runtime initialization aborted: session replaced");
    }

    const manager = new managerMod.LspManager(
      options.cwd,
      undefined,
      options.callbacks,
      undefined,
      options.pendingProvider ?? undefined,
    );
    const fileSync = new fileSyncMod.FileSync(manager);
    fileSync.setSyntheticDotChecker(options.syntheticDotChecker);
    const treeSitter = new treeSitterMod.TreeSitterManager();
    const workspaceIndex = new workspaceIndexMod.WorkspaceIndex(options.cwd, treeSitter);
    fileSync.setTreeSitter(treeSitter, workspaceIndex);

    try {
      options.configureManager?.(manager);
    } catch (err) {
      await manager.shutdownAll().catch(() => {});
      treeSitter.shutdown();
      throw err;
    }

    if (gen !== this.generation) {
      await manager.shutdownAll().catch(() => {});
      treeSitter.shutdown();
      throw new Error("LSP runtime initialization aborted: session replaced");
    }

    const services: LspRuntimeServices = {
      manager,
      fileSync,
      treeSitter,
      workspaceIndex,
    };
    this.services = services;
    return services;
  }

  private async shutdownServices(services: LspRuntimeServices): Promise<void> {
    await services.manager.shutdownAll().catch(() => {});
    services.treeSitter.shutdown();
  }
}
