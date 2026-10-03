import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspClient } from "../src/builtin-extensions/pi-lsp-extension/src/lsp-client.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	connect: vi.fn(),
	createConnection: vi.fn(),
	connection: {
		onNotification: vi.fn(),
		onRequest: vi.fn(),
		onError: vi.fn(),
		onClose: vi.fn(),
		listen: vi.fn(),
		dispose: vi.fn(),
		sendRequest: vi.fn(),
		sendNotification: vi.fn(),
	},
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:net", () => ({ connect: mocks.connect }));
vi.mock("vscode-languageserver-protocol/node", () => ({
	createMessageConnection: mocks.createConnection,
	StreamMessageReader: class {},
	StreamMessageWriter: class {},
	SocketMessageReader: class {},
	SocketMessageWriter: class {},
}));
class FakeChild extends EventEmitter {
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	kill = vi.fn((signal: NodeJS.Signals) => {
		this.killed = true;
		if (signal === "SIGKILL") this.exit(null, signal);
		return true;
	});
	exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit("exit", code, signal);
	}
}
class FakeSocket extends EventEmitter {
	destroy = vi.fn(() => {
		this.emit("close");
		return this;
	});
}
function setup(socketPath?: string) {
	const child = new FakeChild();
	const socket = new FakeSocket();
	let connected!: () => void;
	mocks.spawn.mockReturnValue(child);
	mocks.connect.mockImplementation((_path: string, callback: () => void) => {
		connected = callback;
		return socket;
	});
	const unexpected = vi.fn();
	const client = new LspClient({
		command: "fake-server",
		args: [],
		rootDir: process.cwd(),
		languageId: "test",
		socketPath,
		onUnexpectedExit: unexpected,
	});
	return { client, child, socket, connected: () => connected(), unexpected };
}
async function startDirect(client: LspClient, child: FakeChild) {
	const starting = client.start();
	child.emit("spawn");
	await starting;
}
beforeEach(() => {
	vi.useFakeTimers();
	mocks.createConnection.mockReturnValue(mocks.connection);
	mocks.connection.sendRequest.mockResolvedValue({ capabilities: {} });
	mocks.connection.sendNotification.mockResolvedValue(undefined);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe("LSP owned client lifecycle", () => {
	it("escalates a signalled but still running child and awaits its actual exit", async () => {
		const { client, child } = setup();
		await startDirect(client, child);
		const shutdown = client.shutdown();
		let done = false;
		void shutdown.then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(child.killed).toBe(true);
		const finishedBeforeExit = done;
		await vi.advanceTimersByTimeAsync(2000);
		await shutdown;
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(finishedBeforeExit).toBe(false);
		expect(done).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not escalate a child that exits after SIGTERM", async () => {
		const { client, child } = setup();
		await startDirect(client, child);
		const shutdown = client.shutdown();
		await vi.advanceTimersByTimeAsync(0);
		child.exit();
		await shutdown;
		await vi.advanceTimersByTimeAsync(3000);
		expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("reports failure if SIGKILL still produces no exit within the bound", async () => {
		const { client, child } = setup();
		child.kill.mockImplementation(() => true);
		await startDirect(client, child);
		const stopped = expect(client.shutdown()).rejects.toThrow(/did not exit after SIGKILL/);
		await vi.advanceTimersByTimeAsync(3000);
		await stopped;
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels a pending spawn and ignores its later spawn event", async () => {
		const { client, child } = setup();
		const starting = expect(client.start()).rejects.toThrow(/shut down/);
		const stopped = client.shutdown();
		child.emit("spawn");
		await vi.advanceTimersByTimeAsync(2000);
		await Promise.all([starting, stopped]);
		expect(mocks.createConnection).not.toHaveBeenCalled();
		expect(client.initialized).toBe(false);
		expect(client.disposed).toBe(true);
	});
	it("rejects a failed spawn without constructing a transport or signalling a missing child", async () => {
		const { client, child, unexpected } = setup();
		const starting = expect(client.start()).rejects.toThrow(/Failed to spawn/);
		child.exitCode = -2;
		child.emit("error", Object.assign(new Error("missing command"), { code: "ENOENT" }));
		await starting;
		expect(client.disposed).toBe(true);
		expect(mocks.createConnection).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
		expect(unexpected).not.toHaveBeenCalled();
	});

	it("cancels initialization and cannot initialize after a late server reply", async () => {
		const { client, child } = setup();
		const initialize = deferred<{ capabilities: object }>();
		mocks.connection.sendRequest.mockReturnValue(initialize.promise);
		const starting = expect(client.start()).rejects.toThrow(/shut down/);
		child.emit("spawn");
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.connection.sendRequest).toHaveBeenCalledWith("initialize", expect.anything());
		const stopped = client.shutdown();
		await vi.advanceTimersByTimeAsync(2000);
		await Promise.all([starting, stopped]);
		initialize.resolve({ capabilities: {} });
		await vi.advanceTimersByTimeAsync(0);
		expect(client.initialized).toBe(false);
		expect(mocks.connection.sendNotification).not.toHaveBeenCalled();
	});
	it("captures and closes a connecting socket without attaching after shutdown", async () => {
		const { client, socket, connected, child, unexpected } = setup("/fake.sock");
		const starting = expect(client.start()).rejects.toThrow(/shut down/);
		await client.shutdown();
		connected();
		await starting;
		expect(socket.destroy).toHaveBeenCalled();
		expect(mocks.createConnection).not.toHaveBeenCalled();
		expect(child.kill).not.toHaveBeenCalled();
		expect(unexpected).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("disconnects from a shared daemon without shutdown requests or process signals", async () => {
		const { client, socket, connected } = setup("/fake.sock");
		const starting = client.start();
		connected();
		await starting;
		expect(client.initialized).toBe(true);
		await client.shutdown();
		expect(socket.destroy).toHaveBeenCalledOnce();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.connection.sendRequest).not.toHaveBeenCalled();
		expect(mocks.connection.sendNotification).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("reports an established daemon connection's unexpected close after a transport error", async () => {
		const { client, socket, connected, unexpected } = setup("/fake.sock");
		const starting = client.start();
		connected();
		await starting;
		socket.emit("error", new Error("connection reset"));
		socket.emit("close");
		expect(unexpected).toHaveBeenCalledExactlyOnceWith(null);
		expect(client.initialized).toBe(false);
		await client.shutdown();
	});

	it("handles owned pipe errors and rejected notifications without host exception hooks", async () => {
		const listeners = process.listeners("uncaughtException");
		const { client, child } = setup();
		await startDirect(client, child);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const pipeError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		child.stdin.emit("error", pipeError);
		mocks.connection.sendNotification.mockRejectedValueOnce(pipeError);
		client.didClose("file:///test.ts");
		await vi.advanceTimersByTimeAsync(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Notification failed"));
		expect(process.listeners("uncaughtException")).toEqual(listeners);
		child.exit();
		await client.shutdown();
	});
	it("handles a broken pipe with the actual JSON-RPC reader and writer", async () => {
		vi.useRealTimers();
		const protocol = await vi.importActual<typeof import("vscode-languageserver-protocol/node")>(
			"vscode-languageserver-protocol/node",
		);
		const { client, child } = setup();
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.createConnection.mockImplementation(() =>
			protocol.createMessageConnection(
				new protocol.StreamMessageReader(child.stdout),
				new protocol.StreamMessageWriter(child.stdin),
			),
		);
		let outgoing = "";
		child.stdin.on("data", (chunk: Buffer) => {
			outgoing += chunk.toString();
			const divider = outgoing.indexOf("\r\n\r\n");
			if (divider < 0) return;
			const length = Number(outgoing.slice(0, divider).split(": ")[1]);
			const body = outgoing.slice(divider + 4);
			if (Buffer.byteLength(body) < length) return;
			const message = JSON.parse(body.slice(0, length)) as { method: string; id?: number };
			outgoing = "";
			if (message.method !== "initialize") return;
			const result = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
			child.stdout.write(`Content-Length: ${Buffer.byteLength(result)}\r\n\r\n${result}`);
		});
		await startDirect(client, child);
		child.stdin.destroy(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
		client.didClose("file:///test.ts");
		await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("Notification failed")));
		child.exit();
		await client.shutdown();
	});

	it("bounds graceful shutdown even when the exit notification never settles", async () => {
		const { client, child } = setup();
		await startDirect(client, child);
		mocks.connection.sendNotification.mockReturnValue(new Promise(() => {}));
		const stopped = client.shutdown();
		await vi.advanceTimersByTimeAsync(5000);
		await stopped;
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
