/**
 * lunR: `lunr gateway` subcommand interception, following the
 * handlePackageCommand/handleConfigCommand pattern in package-manager-cli.ts.
 * Returns true when the args were a gateway command (handled — the caller
 * must not continue normal startup).
 */

import { runGateway } from "./index.ts";

export async function handleGatewayCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "gateway") {
		return false;
	}
	const code = await runGateway(args.slice(1));
	process.exitCode = code;
	return true;
}
