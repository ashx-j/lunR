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

export interface RpcProcessOptions {
	cwd: string;
	childProcess?: ChildProcess;
	disposeGraceMs?: number;
	forceKillGraceMs?: number;
	forceKill?: (child: ChildProcess) => void;
}

const DEFAULT_DISPOSE_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 1_000;
const require = createRequire(import.meta.url);

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RpcProcessInstance {
	readonly process: ChildProcess;

	private exited = false;
	private disposePromise?: Promise<void>;
	private readonly disposeGraceMs: number;
	private readonly forceKillGraceMs: number;
	private readonly forceKill: (child: ChildProcess) => void;
	private nextRequestId = 0;
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly exitListeners = new Set<(error?: Error) => void>();
	private uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	constructor(options: RpcProcessOptions) {
		if (options.childProcess) {
			this.process = options.childProcess;
		} else {
			const rpcCommand = this.getSpawnCommand();
			this.process = spawn(rpcCommand.command, rpcCommand.args, {
				cwd: options.cwd,
				env: process.env,
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
		}
		this.disposeGraceMs = options.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS;
		this.forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS;
		this.forceKill = options.forceKill ?? ((child) => forceKillProcessTree(child, !options.childProcess));
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

		this.process.once("error", (error) => {
			this.exited = true;
			const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.rejectAllPending(wrapped);
			this.notifyExit(wrapped);
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
		if (this.exited) {
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
		if (this.exited) {
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

	private hasExited(): boolean {
		return this.exited || this.process.exitCode !== null || this.process.signalCode !== null;
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.hasExited()) return Promise.resolve(true);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (exited: boolean) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.process.off("exit", onExit);
				this.process.off("error", onError);
				resolve(exited);
			};
			const onExit = () => finish(true);
			const onError = () => finish(true);
			this.process.once("exit", onExit);
			this.process.once("error", onError);
			timer = setTimeout(() => finish(this.hasExited()), Math.max(0, timeoutMs));
			timer.unref?.();
			if (this.hasExited()) finish(true);
		});
	}

	private async disposeOnce(): Promise<void> {
		this.uiRequestHandler = undefined;
		this.rejectAllPending(new Error("RPC process disposed"));
		if (this.hasExited()) return;

		const gracefulExit = this.waitForExit(this.disposeGraceMs);
		try {
			this.process.kill("SIGTERM");
		} catch {
			// Escalation below handles processes that reject the graceful signal.
		}
		if (await gracefulExit) return;

		try {
			this.forceKill(this.process);
		} catch {
			// Disposal stays bounded even if the platform kill mechanism fails.
		}
		await this.waitForExit(this.forceKillGraceMs);
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeOnce();
		return this.disposePromise;
	}
}

function forceKillProcessTree(child: ChildProcess, killProcessGroup: boolean): void {
	if (process.platform === "win32") {
		if (child.pid) {
			const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.unref();
		}
		try {
			child.kill("SIGKILL");
		} catch {}
		return;
	}
	if (killProcessGroup && child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

export function createRpcProcessInstance(options: { cwd: string }): RpcProcessInstance {
	return new RpcProcessInstance(options);
}
