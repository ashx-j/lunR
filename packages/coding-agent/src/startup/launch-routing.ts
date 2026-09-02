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
	if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
		return "deferred";
	}
	if (args.some((arg) => arg === "--print" || arg === "-p" || arg === "--export" || arg === "--list-models")) {
		return "deferred";
	}
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] === "--mode" && (args[index + 1] === "rpc" || args[index + 1] === "json")) {
			return "deferred";
		}
	}
	if (environment.startupBenchmark) return "interactive";
	return environment.stdinIsTTY && environment.stdoutIsTTY ? "interactive" : "deferred";
}
