import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

const CONFLICTS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_EXTRA_BODY",
] as const;
const BACKEND_SWITCHES: ReadonlySet<string> = new Set([
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
]);
const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

/**
 * Minimal environment for every Claude Code process lunR starts. Inherited API keys, endpoints, and
 * cloud backends would silently move a subscription request elsewhere, so `strict` refuses them.
 * Telemetry, error reporting, and self-updates stay off because lunR pins the binary.
 */
export function claudeCodeEnvironment(configDir?: string, strict = true): Record<string, string> {
	const conflicting = CONFLICTS.filter((name) => {
		const value = process.env[name];
		return value && (!BACKEND_SWITCHES.has(name) || !["0", "false", "no", "off"].includes(value.toLowerCase()));
	});
	if (strict && conflicting.length)
		throw new Error(`Claude Code subscription refuses conflicting environment variables: ${conflicting.join(", ")}`);
	if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
		throw new Error("Claude Code subscription requires TLS certificate verification");
	const env: Record<string, string> = {};
	for (const name of ENV_ALLOWLIST) {
		const value = process.env[name];
		if (value) env[name] = value;
	}
	if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	env.DISABLE_TELEMETRY = "1";
	env.DISABLE_ERROR_REPORTING = "1";
	env.DISABLE_AUTOUPDATER = "1";
	return env;
}

/**
 * Starts Claude Code in its own process group (POSIX) so `stopProcessTree` can end it with every
 * helper it spawned. stderr is discarded: native diagnostics never reach lunR's output.
 */
export function spawnClaudeCode(
	command: string,
	args: readonly string[],
	env: Record<string, string>,
	cwd?: string,
): ChildProcessWithoutNullStreams {
	const child = spawn(command, args, {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
		env,
		cwd,
	});
	child.stderr.resume();
	child.stdin.on("error", () => {});
	return child;
}

/** Ends a Claude Code process and its children. Safe to call after the process has exited. */
export async function stopProcessTree(pid: number | undefined): Promise<void> {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			const timer = setTimeout(() => {
				killer.kill();
				resolve();
			}, 3000);
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			killer.once("error", done);
			killer.once("close", done);
		});
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* Already exited. */
	}
}

/** One parsed stdout line from Claude Code's stream-json output. Non-JSON lines are skipped. */
export type ClaudeCodeEvent = Record<string, unknown>;

const MAX_LINE = 64 * 1024 * 1024;

/** Parses Claude Code's newline-delimited JSON output into events, keeping UTF-8 split across chunks intact. */
export async function* claudeCodeEvents(stdout: AsyncIterable<Buffer>): AsyncGenerator<ClaudeCodeEvent> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "";
	for await (const chunk of stdout) {
		buffer += decoder.decode(chunk, { stream: true });
		if (buffer.length > MAX_LINE) throw new Error("Claude Code output line exceeds size limit");
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line.startsWith("{")) continue;
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object" && !Array.isArray(value)) yield { ...value };
		}
	}
	decoder.decode();
}
