import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { isBunBinary } from "./config.ts";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

const require = createRequire(import.meta.url);
export const RPC_TERMINATE_GRACE_MS = 5_000;
export const RPC_KILL_CONFIRM_MS = 2_000;

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private disposing = false;
	private disposalPromise?: Promise<void>;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: { cwd: string }) {
		const rpcCommand = this.getSpawnCommand();
		this.process = spawn(rpcCommand.command, rpcCommand.args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create RPC process stdio");
		}
		this.attachListeners();
	}

	private getSpawnCommand(): { command: string; args: string[] } {
		if (isBunBinary) {
			return {
				command: join(dirname(process.execPath), process.platform === "win32" ? "lunr.exe" : "lunr"), // lunr: was "pi"/"pi.exe"
				args: ["--mode", "rpc"],
			};
		}
		return {
			command: process.execPath,
			args: [require.resolve("@earendil-works/pi-coding-agent/rpc-entry")],
		};
	}

	private attachListeners(): void {
		this.process.stdout?.setEncoding("utf8");
		this.process.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			while (true) {
				const newlineIndex = this.stdoutBuffer.indexOf("\n");
				if (newlineIndex === -1) {
					break;
				}
				const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
				if (!line) {
					continue;
				}
				this.handleLine(line);
			}
		});

		this.process.stderr?.setEncoding("utf8");
		this.process.stderr?.on("data", (chunk: string) => {
			this.stderrBuffer += chunk;
		});

		this.process.on("error", (error) => {
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			// A failed spawn has no process to terminate. A later kill error is not exit confirmation.
			if (this.process.pid === undefined) {
				this.exited = true;
				this.notifyExit(wrapped);
			}
		});

		this.process.once("exit", (code, signal) => {
			this.exited = true;
			const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(error);
			this.notifyExit(error);
		});
	}

	private handleLine(line: string): void {
		const parsed = JSON.parse(line) as { type?: string; id?: string };
		switch (parsed.type) {
			case "response": {
				if (!parsed.id) {
					return;
				}
				const pending = this.pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				this.pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				this.uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				for (const listener of this.eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	}

	private rejectAllPending(error: Error): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.reject(error);
		}
	}

	private notifyExit(error?: Error): void {
		for (const listener of this.exitListeners) {
			listener(error);
		}
	}

	send(command: RpcCommand): Promise<RpcResponse> {
		if (this.exited || this.disposing) {
			throw new Error(`RPC process is not running. Stderr: ${this.stderrBuffer}`);
		}
		const id = command.id ?? `orchestrator_${++this.nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });
			this.process.stdin?.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				this.pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	}

	handleUiResponse(response: RpcExtensionUIResponse): void {
		if (this.exited || this.disposing) {
			return;
		}
		this.process.stdin?.write(`${JSON.stringify(response)}\n`);
	}

	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void {
		this.uiRequestHandler = handler;
	}

	onEvent(listener: (event: AgentSessionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onExit(listener: (error?: Error) => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	dispose(): Promise<void> {
		if (this.disposalPromise) return this.disposalPromise;
		this.disposing = true;
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		this.disposalPromise = this.terminate().finally(() => {
			this.disposalPromise = undefined;
		});
		return this.disposalPromise;
	}

	private async terminate(): Promise<void> {
		if (this.exited) return;
		if (await this.signalAndWait("SIGTERM", RPC_TERMINATE_GRACE_MS)) return;
		if (await this.signalAndWait("SIGKILL", RPC_KILL_CONFIRM_MS)) return;
		throw new Error(`RPC process ${this.process.pid ?? "unknown"} termination unconfirmed after SIGTERM and SIGKILL`);
	}

	private signalAndWait(signal: NodeJS.Signals, timeoutMs: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				this.process.off("exit", finish);
				this.process.off("error", onError);
				resolve(this.exited);
			};
			const onError = () => {
				if (this.exited) finish();
			};
			const timer = setTimeout(finish, timeoutMs);
			// Subscribe before kill, including for synchronously exiting test/process adapters.
			this.process.once("exit", finish);
			this.process.on("error", onError);
			try {
				if (!this.process.kill(signal)) finish();
			} catch {
				finish();
			}
		});
	}
}

export function createRpcProcessInstance(options: { cwd: string }): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
