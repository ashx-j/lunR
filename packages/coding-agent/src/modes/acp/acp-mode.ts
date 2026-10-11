import { Readable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { takeOverStdout } from "../../core/output-guard.ts";
import { LunrAcpAgent } from "./agent.ts";
import { acpWorkerArgs } from "./args.ts";

// adapted from pi-acp's stdio entry; retain the agent directly so disconnect cleanup is awaited.
export async function runAcpMode(args: string[]): Promise<void> {
	const forwarded = acpWorkerArgs(args);
	const write = process.stdout.write.bind(process.stdout);
	takeOverStdout();
	const output = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				write(chunk, (error) => (error ? reject(error) : resolve()));
			});
		},
	});
	const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	let agent: LunrAcpAgent | undefined;
	const connection = new AgentSideConnection(
		(client) => {
			agent = new LunrAcpAgent(client, forwarded);
			return agent;
		},
		ndJsonStream(output, input),
	);
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			await agent?.dispose();
		})();
		return closing;
	};
	const onSignal = () => {
		void close().finally(() => process.exit(0));
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	process.once("disconnect", onSignal);
	process.stdout.once("error", onSignal);
	try {
		await connection.closed;
	} finally {
		await close();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		process.off("disconnect", onSignal);
		process.stdout.off("error", onSignal);
	}
}
