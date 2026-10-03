import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspClientOptions } from "../src/builtin-extensions/pi-lsp-extension/src/lsp-client.js";
import { LspManager } from "../src/builtin-extensions/pi-lsp-extension/src/lsp-manager.js";
import { DefaultWorkspaceProvider } from "../src/builtin-extensions/pi-lsp-extension/src/workspace-provider.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const clients = vi.hoisted(() => ({
	created: [] as Array<{
		options: LspClientOptions;
		initialized: boolean;
		disposed: boolean;
		start: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
	}>,
	start: vi.fn<() => Promise<void>>(),
	shutdown: vi.fn<() => Promise<void>>(),
}));
vi.mock("../src/builtin-extensions/pi-lsp-extension/src/lsp-client.js", () => ({
	LspClient: class {
		initialized = false;
		disposed = false;
		constructor(public options: LspClientOptions) {
			clients.created.push(this);
		}
		start = vi.fn(async () => {
			await clients.start();
			if (!this.disposed) this.initialized = true;
		});
		shutdown = vi.fn(async () => {
			this.disposed = true;
			this.initialized = false;
			await clients.shutdown();
		});
	},
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	clients.created.length = 0;
	clients.start.mockReset();
	clients.shutdown.mockReset();
});

function setup(stateDir: string | null = null) {
	const workspace = {
		...new DefaultWorkspaceProvider(),
		type: "test",
		workspaceRoot: null,
		stateDir,
		getWorkspaceFolders: () => [],
		getStatusText: () => "",
		ensureReady: vi.fn(async () => true),
		shutdown: vi.fn(),
	};
	const ready = vi.fn();
	const error = vi.fn();
	const manager = new LspManager(
		process.cwd(),
		undefined,
		{ onServerReady: ready, onServerError: error },
		"test",
		workspace,
	);
	return { manager, workspace, ready, error };
}

describe("LSP manager startup ownership", () => {
	it("registers eager work before callbacks can shut the manager down", async () => {
		const workspace = new DefaultWorkspaceProvider();
		const prepare = vi.spyOn(workspace, "ensureReady");
		let stopped!: Promise<void>;
		const manager = new LspManager(
			process.cwd(),
			undefined,
			{
				onWorkspaceSetupStart: () => {
					stopped = manager.shutdownAll();
				},
			},
			"test",
			workspace,
		);
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(stopped).toBeDefined());
		await stopped;
		expect(prepare).not.toHaveBeenCalled();
		expect(clients.created).toHaveLength(0);
		expect(manager.isServerStarting("typescript")).toBe(false);
	});

	it("cancels workspace preparation without starting or attaching after it resolves", async () => {
		const { manager, workspace, ready, error } = setup();
		const gate = deferred<boolean>();
		workspace.ensureReady.mockReturnValue(gate.promise);
		manager.startEagerly(["typescript", "python"]);
		await vi.waitFor(() => expect(workspace.ensureReady).toHaveBeenCalledTimes(1));
		await manager.shutdownAll();
		gate.resolve(true);
		await Promise.resolve();
		expect(clients.created).toHaveLength(0);
		expect(ready).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(manager.isServerStarting("typescript")).toBe(false);
		expect(await manager.getClientForLanguage("python")).toBeNull();
		manager.startEagerly(["python"]);
		await expect(manager.restartServer("python")).rejects.toThrow(/shut down/);
		expect(clients.created).toHaveLength(0);
	});

	it("awaits a partially initialized client's cleanup and refuses its late result", async () => {
		const { manager, ready, error } = setup();
		const start = deferred<void>();
		const closing = deferred<void>();
		clients.start.mockReturnValue(start.promise);
		clients.shutdown.mockReturnValue(closing.promise);
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(clients.created).toHaveLength(1));
		const client = clients.created[0];
		const shutdown = manager.shutdownAll();
		let done = false;
		void shutdown.then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(client.shutdown).toHaveBeenCalled();
		expect(done).toBe(false);
		start.resolve();
		closing.resolve();
		await shutdown;
		expect(manager.getRunningClient("typescript")).toBeNull();
		expect(client.disposed).toBe(true);
		expect(ready).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("closes failed clients before retrying a stale daemon or direct fallback", async () => {
		const { manager, ready } = setup("/fake-state");
		const internals = manager as unknown as { isDaemonAlive: () => boolean; spawnDaemon: () => Promise<void> };
		vi.spyOn(internals, "isDaemonAlive").mockReturnValueOnce(true).mockReturnValue(false);
		vi.spyOn(internals, "spawnDaemon").mockRejectedValue(new Error("daemon unavailable"));
		clients.start.mockRejectedValueOnce(new Error("stale socket")).mockResolvedValue();
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
		expect(clients.created).toHaveLength(2);
		expect(clients.created[0].shutdown).toHaveBeenCalled();
		expect(clients.created[0].disposed).toBe(true);
		expect(clients.created[1].options.socketPath).toBeUndefined();
		await manager.shutdownAll();
	});

	it("disconnects a pending shared connection without daemon or direct fallback", async () => {
		const { manager, ready, error } = setup("/fake-state");
		const internals = manager as unknown as {
			isDaemonAlive: () => boolean;
			spawnDaemon: () => Promise<void>;
			killDaemon: () => void;
		};
		vi.spyOn(internals, "isDaemonAlive").mockReturnValue(true);
		const spawn = vi.spyOn(internals, "spawnDaemon");
		const kill = vi.spyOn(internals, "killDaemon");
		const gate = deferred<void>();
		clients.start.mockReturnValue(gate.promise);
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(clients.created).toHaveLength(1));
		await manager.shutdownAll();
		gate.reject(new Error("socket cancelled"));
		await Promise.resolve();
		expect(clients.created[0].options.socketPath).toContain("lsp-typescript.sock");
		expect(clients.created[0].disposed).toBe(true);
		expect(clients.created).toHaveLength(1);
		expect(spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(ready).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it("cancels daemon retry delays without starting a direct fallback", async () => {
		const { manager, error } = setup("/fake-state");
		const internals = manager as unknown as { isDaemonAlive: () => boolean; spawnDaemon: () => Promise<void> };
		vi.spyOn(internals, "isDaemonAlive").mockReturnValueOnce(false).mockReturnValue(true);
		vi.spyOn(internals, "spawnDaemon").mockResolvedValue();
		clients.start.mockRejectedValue(new Error("not listening yet"));
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(clients.created).toHaveLength(1));
		await manager.shutdownAll();
		expect(clients.created).toHaveLength(1);
		expect(clients.created[0].disposed).toBe(true);
		expect(error).not.toHaveBeenCalled();
	});

	it("closes a pending start's client before an explicit restart replaces it", async () => {
		const { manager } = setup();
		const gate = deferred<void>();
		clients.start.mockReturnValueOnce(gate.promise).mockResolvedValue();
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(clients.created).toHaveLength(1));
		const restarted = manager.restartServer("typescript");
		gate.resolve();
		await restarted;
		expect(clients.created).toHaveLength(2);
		expect(clients.created[0].disposed).toBe(true);
		expect(manager.getRunningClient("typescript")).toBe(clients.created[1]);
		await manager.shutdownAll();
		expect(clients.created[1].disposed).toBe(true);
	});

	it("cancels scheduled crash restarts when the session shuts down", async () => {
		const { manager, ready } = setup();
		manager.startEagerly(["typescript"]);
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
		vi.useFakeTimers();
		clients.created[0].options.onUnexpectedExit?.(1);
		await manager.shutdownAll();
		await vi.runAllTimersAsync();
		expect(clients.created).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
