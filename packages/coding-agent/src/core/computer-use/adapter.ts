import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MacRuntime } from "./macos-runtime.ts";
import { CUA_VERSION, installRuntime, runtimeEnvironment } from "./runtime.ts";
import { assertInteractiveDesktop } from "./windows-desktop.ts";

export type DriverReply = Awaited<ReturnType<Client["callTool"]>>;
export interface ComputerDriver {
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply>;
	close(): Promise<void>;
	setProcessObserver?(observer: (pid: number) => Promise<void>): void;
}

export class CuaAdapter implements ComputerDriver {
	private client?: Client;
	private transport?: StdioClientTransport;
	private mac?: MacRuntime;
	private stateDirectory?: string;
	private connecting?: Promise<void>;
	private closing?: Promise<void>;
	private readonly abort = new AbortController();
	private processObserver?: (pid: number) => Promise<void>;
	setProcessObserver(observer: (pid: number) => Promise<void>): void {
		this.processObserver = observer;
	}

	private async connect(signal: AbortSignal): Promise<void> {
		const { command, app } = await installRuntime(signal);
		signal.throwIfAborted();
		let args = ["mcp", "--direct", "--embedded", "--no-overlay"];
		if (app) {
			this.mac = new MacRuntime();
			const socket = await this.mac.start(app, signal);
			args = ["mcp", "--embedded", "--socket", socket, "--no-overlay"];
		}
		signal.throwIfAborted();
		const state = await mkdtemp(join(await realpath(tmpdir()), "lunr-cua-client-"));
		this.stateDirectory = state;
		const appData = join(state, "AppData");
		await mkdir(appData);
		signal.throwIfAborted();
		this.transport = new StdioClientTransport({
			command,
			args,
			stderr: "pipe",
			env: {
				...runtimeEnvironment(),
				HOME: state,
				USERPROFILE: state,
				APPDATA: appData,
				LOCALAPPDATA: appData,
				XDG_CONFIG_HOME: appData,
				XDG_STATE_HOME: appData,
			},
		});
		// Drain diagnostics without retaining desktop or runtime data in session history.
		this.transport.stderr?.on("data", () => {});
		this.client = new Client({ name: "lunr-computer-use", version: CUA_VERSION });
		await this.client.connect(this.transport, { timeout: 15000, signal });
		signal.throwIfAborted();
		if (this.client.getServerVersion()?.version !== CUA_VERSION)
			throw new Error("Computer runtime version mismatch.");
		for (const pid of [this.transport.pid, this.mac?.processId]) {
			if (pid) await this.processObserver?.(pid);
		}
	}

	async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverReply> {
		const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
		combined.throwIfAborted();
		try {
			await assertInteractiveDesktop(combined);
			combined.throwIfAborted();
			this.connecting ??= this.connect(AbortSignal.any([combined, AbortSignal.timeout(60000)]));
			await this.connecting;
			combined.throwIfAborted();
			if (!this.client) throw new Error("Computer connection closed.");
			return await this.client.callTool({ name, arguments: args }, undefined, { timeout: 15000, signal: combined });
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	close(): Promise<void> {
		this.abort.abort();
		this.closing ??= this.stop();
		return this.closing;
	}

	private async stop(): Promise<void> {
		await this.connecting?.catch(() => undefined);
		const pid = this.transport?.pid;
		await this.client?.close();
		await this.transport?.close();
		if (pid) {
			const deadline = Date.now() + 5000;
			for (;;) {
				try {
					process.kill(pid, 0);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
					throw error;
				}
				if (Date.now() >= deadline)
					throw new Error("Owned computer process shutdown is unconfirmed. Desktop lease retained.");
				await delay(50);
			}
		}
		await this.mac?.close();
		if (this.stateDirectory) await rm(this.stateDirectory, { recursive: true, force: true });
		this.client = undefined;
		this.transport = undefined;
	}
}
