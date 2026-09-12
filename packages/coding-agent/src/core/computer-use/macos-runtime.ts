import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CUA_VERSION, runtimeEnvironment } from "./runtime.ts";

const exec = promisify(execFile);

export function macLaunchArguments(app: string, socket: string, home: string, lifetime: string): string[] {
	const environment = {
		HOME: home,
		...Object.fromEntries(Object.entries(runtimeEnvironment()).filter(([name]) => name.startsWith("CUA_"))),
	};
	return [
		"-n",
		"-g",
		"-W",
		"-a",
		app,
		"--stdin",
		lifetime,
		...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
		"--args",
		"serve",
		"--embedded",
		"--parent-liveness-stdio",
		"--socket",
		socket,
		"--permission-mode",
		"standard",
		"--no-overlay",
	];
}

function request(socket: string, method: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const stream = connect(socket);
		let buffer = "";
		stream.setTimeout(1000, () => stream.destroy(new Error("Private computer endpoint timed out.")));
		stream.on("error", reject);
		stream.on("connect", () => stream.write(`${JSON.stringify({ method, args })}\n`));
		stream.on("data", (chunk) => {
			buffer += chunk.toString();
			if (buffer.length > 65536) {
				stream.destroy(new Error("Invalid private endpoint metadata."));
				return;
			}
			if (!buffer.includes("\n")) return;
			try {
				const reply: unknown = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
				if (
					!reply ||
					typeof reply !== "object" ||
					!("result" in reply) ||
					!reply.result ||
					typeof reply.result !== "object"
				)
					throw new Error("Private endpoint refused metadata.");
				resolve(Object.fromEntries(Object.entries(reply.result)));
			} catch (error) {
				reject(error);
			}
			stream.destroy();
		});
		stream.on("end", () => reject(new Error("Private computer endpoint closed.")));
	});
}

export class MacRuntime {
	private directory?: string;
	private lifetime?: FileHandle;
	private exited?: Promise<void>;
	private pid?: number;
	get processId(): number | undefined {
		return this.pid;
	}
	private socket?: string;
	private closing?: Promise<void>;

	async start(app: string, signal: AbortSignal): Promise<string> {
		const directory = await mkdtemp(join(await realpath(tmpdir()), "lunr-cua-"));
		this.directory = directory;
		const socket = join(directory, "driver.sock");
		this.socket = socket;
		const lifetime = join(directory, "lifetime");
		await exec("/usr/bin/mkfifo", ["-m", "600", lifetime], { timeout: 5000, signal });
		this.lifetime = await open(lifetime, constants.O_RDWR);
		signal.throwIfAborted();
		const launcher = spawn("/usr/bin/open", macLaunchArguments(app, socket, directory, lifetime), {
			env: runtimeEnvironment(),
			stdio: "ignore",
		});
		this.exited = new Promise<void>((resolve, reject) => {
			launcher.once("error", reject);
			launcher.once("exit", (code) =>
				code === 0 ? resolve() : reject(new Error(`LaunchServices exited ${code}.`)),
			);
		});
		void this.exited.catch(() => undefined);
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			try {
				const metadata = await request(socket, "metadata");
				if (
					metadata.driver_version !== CUA_VERSION ||
					metadata.embedded !== true ||
					typeof metadata.pid !== "number" ||
					metadata.pid < 1
				)
					throw new Error("Private runtime has incompatible metadata.");
				this.pid = metadata.pid;
				return socket;
			} catch {
				await Promise.race([
					delay(100, undefined, { signal }),
					this.exited.then(() => {
						throw new Error("Computer app exited during startup.");
					}),
				]);
			}
		}
		throw new Error(
			"Private macOS runtime startup timed out. Check CuaDriver Accessibility and Screen Recording grants.",
		);
	}

	close(): Promise<void> {
		this.closing ??= this.stop();
		return this.closing;
	}

	private async stop(): Promise<void> {
		await this.lifetime?.close();
		this.lifetime = undefined;
		if (this.socket && this.pid)
			await request(this.socket, "shutdown_if_pid", { expected_pid: this.pid }).catch(() => undefined);
		if (this.exited) {
			const timeout = new AbortController();
			try {
				await Promise.race([
					this.exited,
					delay(10000, undefined, { signal: timeout.signal }).then(() => {
						throw new Error("Owned macOS app shutdown is unconfirmed. Desktop lease retained.");
					}),
				]);
			} finally {
				timeout.abort();
			}
		}
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
	}
}
