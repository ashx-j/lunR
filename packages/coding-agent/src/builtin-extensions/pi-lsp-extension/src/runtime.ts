import type { FileSync } from "./file-sync.js";
import type { LspManager, LspManagerCallbacks } from "./lsp-manager.js";
import type { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "./tree-sitter/workspace-index.js";
import type { WorkspaceProvider } from "./workspace-provider.js";

export type LspRuntimeCallbacks = LspManagerCallbacks;

export interface LspRuntimeServices {
	manager: LspManager;
	fileSync: FileSync;
	treeSitter: TreeSitterManager;
	workspaceIndex: WorkspaceIndex;
}

export interface LspRuntimeBindOptions {
	cwd: string;
	callbacks: LspRuntimeCallbacks;
	pendingProvider?: WorkspaceProvider | null;
	syntheticDotChecker: (uri: string) => boolean;
	configureManager?: (manager: LspManager) => void;
}

const defaultLoaders = {
	loadLspManager: () => import("./lsp-manager.js"),
	loadFileSync: () => import("./file-sync.js"),
	loadTreeSitter: () => import("./tree-sitter/parser-manager.js"),
	loadWorkspaceIndex: () => import("./tree-sitter/workspace-index.js"),
};

export type LspRuntimeModuleLoaders = Partial<typeof defaultLoaders>;

export class LspRuntimeHost {
	private generation = 0;
	private services: LspRuntimeServices | null = null;
	private initPromise: Promise<LspRuntimeServices> | null = null;
	private bindOptions: LspRuntimeBindOptions | null = null;
	private readonly loaders: typeof defaultLoaders;

	constructor(loaders?: LspRuntimeModuleLoaders) {
		this.loaders = { ...defaultLoaders, ...loaders };
	}

	getGeneration(): number {
		return this.generation;
	}

	hasServices(): boolean {
		return this.services !== null;
	}

	getServicesIfReady(): LspRuntimeServices | null {
		return this.services;
	}

	getBindOptions(): LspRuntimeBindOptions | null {
		return this.bindOptions;
	}

	bindSession(options: LspRuntimeBindOptions): void {
		this.generation++;
		const previous = this.services;
		this.services = null;
		this.initPromise = null;
		this.bindOptions = options;
		if (previous) void this.shutdownServices(previous);
	}

	setPendingProvider(provider: WorkspaceProvider | null): void {
		if (this.bindOptions) this.bindOptions = { ...this.bindOptions, pendingProvider: provider };
		if (this.services && provider) this.services.manager.setWorkspaceProvider(provider);
	}

	async ensureServices(fallbackOptions?: LspRuntimeBindOptions): Promise<LspRuntimeServices> {
		if (this.services) return this.services;
		if (this.initPromise) return this.initPromise;
		if (!this.bindOptions) {
			if (!fallbackOptions) throw new Error("LSP runtime is not bound to a session");
			this.bindOptions = fallbackOptions;
		}
		const gen = this.generation;
		const pending = this.loadServices(gen);
		this.initPromise = pending;
		try {
			return await pending;
		} catch (error) {
			if (this.generation === gen && this.initPromise === pending) this.initPromise = null;
			throw error;
		}
	}

	async shutdown(): Promise<void> {
		this.generation++;
		const previous = this.services;
		this.services = null;
		this.initPromise = null;
		this.bindOptions = null;
		if (previous) await this.shutdownServices(previous);
	}

	private async loadServices(gen: number): Promise<LspRuntimeServices> {
		const [managerMod, fileSyncMod, treeSitterMod, workspaceIndexMod] = await Promise.all([
			this.loaders.loadLspManager(),
			this.loaders.loadFileSync(),
			this.loaders.loadTreeSitter(),
			this.loaders.loadWorkspaceIndex(),
		]);
		const options = this.bindOptions;
		if (gen !== this.generation || !options) {
			throw new Error("LSP runtime initialization aborted: session replaced");
		}
		const manager = new managerMod.LspManager(options.cwd, undefined, options.callbacks, undefined, options.pendingProvider ?? undefined);
		const treeSitter = new treeSitterMod.TreeSitterManager();
		try {
			const fileSync = new fileSyncMod.FileSync(manager);
			fileSync.setSyntheticDotChecker(options.syntheticDotChecker);
			const workspaceIndex = new workspaceIndexMod.WorkspaceIndex(options.cwd, treeSitter);
			fileSync.setTreeSitter(treeSitter, workspaceIndex);
			options.configureManager?.(manager);
			if (gen !== this.generation) throw new Error("LSP runtime initialization aborted: session replaced");
			this.services = { manager, fileSync, treeSitter, workspaceIndex };
			return this.services;
		} catch (error) {
			await manager.shutdownAll().catch(() => {});
			treeSitter.shutdown();
			throw error;
		}
	}

	private async shutdownServices(services: LspRuntimeServices): Promise<void> {
		await services.manager.shutdownAll().catch(() => {});
		services.treeSitter.shutdown();
	}
}
