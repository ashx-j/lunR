export type PreloadLaunchMode = "interactive" | "deferred";

const DEFERRED_COMMANDS = new Set([
	"config",
	"features",
	"gateway",
	"install",
	"list",
	"remove",
	"setup",
	"uninstall",
	"update",
]);

export interface PreloadLaunchEnvironment {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	startupBenchmark: boolean;
}

export function resolvePreloadLaunchMode(
	args: readonly string[],
	environment: PreloadLaunchEnvironment,
): PreloadLaunchMode {
	if (DEFERRED_COMMANDS.has(args[0] ?? "")) return "deferred";
	const parsed = parseArgs([...args]);
	if (
		parsed.help ||
		parsed.version ||
		parsed.print ||
		parsed.export ||
		parsed.listModels !== undefined ||
		parsed.mode === "rpc" ||
		parsed.mode === "json"
	)
		return "deferred";
	if (environment.startupBenchmark) return "interactive";
	return environment.stdinIsTTY && environment.stdoutIsTTY ? "interactive" : "deferred";
}

import { parseArgs } from "../cli/args.ts";
