import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isBunBinary } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.ts";
import type {
	RpcAcpPermissionRequest,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "../rpc/rpc-types.ts";

import { acpWorkerArgs } from "./args.ts";

export type WorkerEvent =
	| AgentSessionEvent
	| RpcExtensionUIRequest
	| RpcAcpPermissionRequest
	| {
			type: "extension_error";
			extensionPath: string;
			event: string;
			error: string;
	  };

export interface WorkerOptions {
	cwd: string;
	configPath: string;
	args: string[];
	sessionPath?: string;
}

// adapted from pi-acp's subprocess transport; the child always runs this lunr installation.
export class AcpRpcProcess {
	private readonly pending = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();
	private readonly events = new Set<(event: WorkerEvent) => void>();
	private readonly exits = new Set<(error: Error) => void>();
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly closed: Promise<void>;
	private readonly stopReading: () => void;
	private failure?: Error;
	private exited = false;
	private stopping?: Promise<void>;
	private sequence = 0;

	constructor(options: WorkerOptions) {
		const compiled = new URL("../../cli.js", import.meta.url);
		const source = new URL("../../cli.ts", import.meta.url);
		const launch = isBunBinary
			? []
			: existsSync(compiled)
				? [fileURLToPath(compiled)]
				: ["--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(source)];
		const env: NodeJS.ProcessEnv = { ...process.env, LUNR_ACP_WORKER_CONFIG: options.configPath };
		// the adapter is a root agent even when its client was launched by another agent.
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_SUBAGENTS_") || key.startsWith("PI_INTERCOM_"))
				delete env[key];
		}
		const args = [
			...launch,
			...acpWorkerArgs(options.args, Boolean(options.sessionPath)),
			"--mode",
			"rpc",
			"--no-themes",
		];
		if (options.sessionPath) args.push("--session", options.sessionPath);
		this.child = spawn(process.execPath, args, { cwd: options.cwd, env, stdio: "pipe", windowsHide: true });
		this.child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
		this.child.stdin.on("error", (error: Error) => this.fail(error));
		this.child.on("error", (error: Error) => this.fail(error));
		this.closed = new Promise((resolve) =>
			this.child.once("close", (code, signal) => {
				this.exited = true;
				this.failure ??= new Error(`lunr worker exited (${signal ?? code}).`);
				// only report a terminal failure once the worker can no longer perform work.
				for (const request of this.pending.values()) request.reject(this.failure);
				this.pending.clear();
				for (const listener of this.exits) listener(this.failure);
				resolve();
			}),
		);
		this.stopReading = attachJsonlLineReader(this.child.stdout, (line) => {
			if (this.failure || !line.trim()) return;
			try {
				const value: unknown = JSON.parse(line);
				if (!value || typeof value !== "object" || !("type" in value))
					throw new Error("Invalid lunr worker message.");
				if (value.type === "response") {
					const response = value as RpcResponse;
					if (response.id) this.pending.get(response.id)?.resolve(response);
				} else {
					for (const listener of this.events) listener(value as WorkerEvent);
				}
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.stopReading();
		this.events.clear();
		void this.stop();
	}

	get usable(): boolean {
		return !this.failure && !this.stopping;
	}

	onEvent(listener: (event: WorkerEvent) => void): () => void {
		this.events.add(listener);
		return () => {
			this.events.delete(listener);
		};
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exits.add(listener);
		if (this.exited && this.failure) listener(this.failure);
		return () => {
			this.exits.delete(listener);
		};
	}

	async request<T extends RpcCommand>(
		command: T,
		timeoutMs = 30_000,
	): Promise<Extract<RpcResponse, { command: T["type"]; success: true }>> {
		if (this.failure) {
			await this.closed;
			throw this.failure;
		}
		if (this.stopping) throw new Error("lunr worker is closing.");
		const id = String(++this.sequence);
		const response = await new Promise<RpcResponse>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`lunr ${command.type} timed out.`));
						}, timeoutMs)
					: undefined;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
			};
			this.pending.set(id, {
				resolve: (value) => {
					cleanup();
					resolve(value);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			this.child.stdin.write(serializeJsonLine({ ...command, id }), (error) => {
				if (error) this.fail(error);
			});
		});
		if (!response.success) throw new Error(response.error);
		if (response.command !== command.type) throw new Error("Mismatched lunr worker response.");
		return response as Extract<RpcResponse, { command: T["type"]; success: true }>;
	}

	respond(response: RpcExtensionUIResponse): void {
		if (!this.failure && !this.stopping) this.child.stdin.write(serializeJsonLine(response));
	}

	stop(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.stopping = (async () => {
			// eof runs lunr's session shutdown hooks, including mcp and background children.
			this.child.stdin.end();
			const term = setTimeout(() => this.child.kill("SIGTERM"), 10_000);
			const kill = setTimeout(() => this.child.kill("SIGKILL"), 15_000);
			try {
				await this.closed;
			} finally {
				clearTimeout(term);
				clearTimeout(kill);
				this.stopReading();
				this.events.clear();
				this.exits.clear();
			}
		})();
		return this.stopping;
	}
}
