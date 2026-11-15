import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest, openRpcStream } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { getRadiusOrchestratorBaseUrl, isRadiusEnabled, radiusPresence } from "./radius.ts";
import { supervisor } from "./supervisor.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true });
	const server = await startIpcServer(
		Object.assign(handleIpcRequest, {
			openRpcStream,
		}),
	);

	try {
		await supervisor.recoverAfterRestart();
		if (isRadiusEnabled()) {
			const machine = await radiusPresence.start();
			console.log(`radius integration enabled: ${socketPath} -> ${getRadiusOrchestratorBaseUrl()}`);
			if (machine) {
				console.log(`radius machine id: ${machine.id}`);
			}
		} else {
			console.log("radius integration disabled: login radius in ~/.lunr/agent/auth.json or set RADIUS_API_KEY");
		}
	} catch (error) {
		try {
			await cleanup();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Orchestrator startup and cleanup failed");
		}
		throw error;
	}

	console.log(`orchestrator listening on ${socketPath}`);

	let shutdownPromise: Promise<void> | undefined;
	let requestedExitCode = 0;
	const shutdown = (exitCode: number) => {
		requestedExitCode = Math.max(requestedExitCode, exitCode);
		if (shutdownPromise) return;
		shutdownPromise = cleanup().then(
			() => {
				process.exit(requestedExitCode);
			},
			(error: unknown) => {
				console.error(error);
				process.exit(1);
			},
		);
	};

	async function cleanup(): Promise<void> {
		const results = await Promise.allSettled([
			Promise.resolve().then(() => server.close()),
			supervisor.shutdown(),
			radiusPresence.stop(),
		]);
		try {
			if (existsSync(socketPath)) unlinkSync(socketPath);
		} catch (error) {
			results.push({ status: "rejected", reason: error });
		}
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "Orchestrator service cleanup failed");
	}

	process.on("SIGINT", () => {
		void shutdown(0);
	});
	process.on("SIGTERM", () => {
		void shutdown(0);
	});
	process.on("uncaughtException", (error) => {
		console.error(error);
		void shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		void shutdown(1);
	});

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
