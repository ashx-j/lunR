import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeTripwire } from "../../api/claude-code-loopback.ts";
import { claudeCodeEnvironment, spawnClaudeCode, stopProcessTree } from "../../api/claude-code-process.ts";
import {
	CLAUDE_CODE_VERSION,
	claudeCodePlatform,
	installClaudeCode,
	managedClaudeCodePath,
} from "../../utils/claude-code-release.ts";
import type { AuthInteraction, ClaudeCodeModelRoute, ExternalClaudeCodeCredential, OAuthAuth } from "../types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Runs a short Claude Code setup command and returns its stdout. Failed exits reject unless `allowFailure`. */
async function run(
	command: string,
	args: string[],
	options: {
		input?: string;
		env?: Record<string, string>;
		cwd?: string;
		timeoutMs?: number;
		allowFailure?: boolean;
	} = {},
): Promise<string> {
	const child = spawnClaudeCode(command, args, options.env ?? claudeCodeEnvironment(undefined, false), options.cwd);
	return new Promise((resolve, reject) => {
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void stopProcessTree(child.pid).finally(() => reject(new Error("Claude Code setup check timed out")));
		}, options.timeoutMs ?? 25_000);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 1024 * 1024) void stopProcessTree(child.pid);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return;
			if (code !== 0 && !options.allowFailure) reject(new Error("Claude Code setup check failed"));
			else resolve(output.trim());
		});
		child.stdin.end(options.input);
	});
}

/** Sign-in state from Claude Code's own credential store. Reading it makes no network request. */
async function signInStatus(
	command: string,
	configDir: string | undefined,
): Promise<{ subscribed: boolean; accountFingerprint?: string }> {
	let status: unknown;
	try {
		const output = await run(command, ["auth", "status"], {
			env: claudeCodeEnvironment(configDir, false),
			allowFailure: true,
		});
		status = output.startsWith("{") ? JSON.parse(output) : undefined;
	} catch {
		status = undefined;
	}
	if (!status || typeof status !== "object" || !("loggedIn" in status) || status.loggedIn !== true)
		return { subscribed: false };
	const plan = "subscriptionType" in status ? String(status.subscriptionType ?? "") : "";
	const email = "email" in status && typeof status.email === "string" ? status.email.trim().toLowerCase() : "";
	return {
		subscribed: /\b(pro|max|team|enterprise)\b/i.test(plan.replaceAll("_", " ")),
		accountFingerprint: email ? createHash("sha256").update(email).digest("hex") : undefined,
	};
}

/** Claude Code's control channel over stream-json stdio: one request at a time, answered by request id. */
function controlChannel(child: ReturnType<typeof spawnClaudeCode>) {
	const pending = new Map<string, { resolve: (response: unknown) => void; reject: (error: Error) => void }>();
	let buffer = "";
	let next = 0;
	const failAll = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			let event: unknown;
			try {
				event = line.startsWith("{") ? JSON.parse(line) : undefined;
			} catch {
				// A garbled line is not a control response; its request times out instead.
				continue;
			}
			if (!isRecord(event) || event.type !== "control_response" || !isRecord(event.response)) continue;
			const id = event.response.request_id;
			const waiter = typeof id === "string" ? pending.get(id) : undefined;
			if (!waiter) continue;
			pending.delete(id as string);
			if (event.response.subtype === "success") waiter.resolve(event.response.response);
			else waiter.reject(new Error("Claude Code rejected a setup request"));
		}
	});
	child.on("close", () => failAll(new Error("Claude Code exited during setup")));
	child.on("error", (error) => failAll(error));
	// A request written as Claude Code exits fails through `close`; the pipe error itself is expected.
	child.stdin.on("error", () => {});
	return {
		request(request: Record<string, unknown>): Promise<unknown> {
			const id = `lunr-${++next}`;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
			});
		},
		failAll,
	};
}

/** Claude Code's own label for a model variant billed from usage credits instead of the plan. */
const USAGE_CREDITS = /usage credits/i;
/** Context window of a Claude Code `[1m]` route, as Claude Code 2.1.263 reported through `get_context_usage`. */
const ONE_MILLION_ROUTE_WINDOW = 1_000_000;

/**
 * The account's models from Claude Code itself, with no Messages request. The `initialize` handshake lists
 * the picker. Since Claude Code 2.1.310, switching models or reading a route's context window asks Anthropic,
 * so setup does neither: a `[1m]` route records 1M and other routes keep lunR's catalog window. A tripwire
 * base URL proves no other request was sent before anything is saved. Variants Claude Code labels as drawing
 * from usage credits are skipped, and the list keeps Claude Code's picker order so its default comes first.
 */
async function discoverModels(command: string, configDir: string | undefined): Promise<ClaudeCodeModelRoute[]> {
	const tripwire = await ClaudeCodeTripwire.open();
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-setup-"));
	const child = spawnClaudeCode(
		command,
		[
			"-p",
			"--model",
			"sonnet",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--tools",
			"",
			"--setting-sources",
			"",
			"--strict-mcp-config",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--disable-slash-commands",
			"--no-session-persistence",
		],
		{ ...claudeCodeEnvironment(configDir, false), ANTHROPIC_BASE_URL: tripwire.baseUrl },
		directory,
	);
	const channel = controlChannel(child);
	const timer = setTimeout(() => channel.failAll(new Error("Claude Code setup check timed out")), 60_000);
	try {
		const picker = await channel.request({ subtype: "initialize" });
		const rows = isRecord(picker) && Array.isArray(picker.models) ? picker.models : [];
		const routes = new Map<string, boolean>();
		for (const row of rows) {
			if (!isRecord(row)) continue;
			const resolved = typeof row.resolvedModel === "string" && row.resolvedModel ? row.resolvedModel : row.value;
			if (typeof resolved !== "string" || !resolved.startsWith("claude-") || routes.has(resolved)) continue;
			routes.set(resolved, typeof row.description === "string" && USAGE_CREDITS.test(row.description));
		}
		const models = new Map<string, ClaudeCodeModelRoute>();
		for (const [route, usageCredits] of routes) {
			if (usageCredits) continue;
			const id = route.replace(/\[1m\]$/, "");
			// Replacing an existing key keeps its first picker position, so a `[1m]` route wins over the plain one.
			if (id !== route) models.set(id, { id, route, contextWindow: ONE_MILLION_ROUTE_WINDOW });
			else if (!models.has(id)) models.set(id, { id, route });
		}
		if (tripwire.tripped) throw new Error("Claude Code model discovery tried to contact Anthropic. Setup not saved.");
		return [...models.values()];
	} finally {
		clearTimeout(timer);
		child.stdin.end();
		await stopProcessTree(child.pid).catch(() => {});
		tripwire.close();
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/** True when the binary starts and reports the pinned version. A spawn error, bad exit or timeout counts as broken. */
async function claudeCodeRuns(command: string): Promise<boolean> {
	try {
		return (await run(command, ["--version"])).startsWith(CLAUDE_CODE_VERSION);
	} catch {
		return false;
	}
}

/**
 * Returns lunR's pinned Claude Code, downloading it after the user agrees and reporting progress in
 * coarse steps. An installed copy that no longer runs (truncated, wrong architecture) is removed and
 * downloaded again, so a bad file never stays behind to be trusted by later sign-ins.
 */
async function ensureClaudeCode(interaction: AuthInteraction): Promise<string> {
	const platform = claudeCodePlatform();
	if (!platform) throw new Error(`Claude Code ${CLAUDE_CODE_VERSION} has no build for ${process.platform} ${arch()}`);
	const command = managedClaudeCodePath(platform);
	if (existsSync(command)) {
		if (await claudeCodeRuns(command)) return command;
		interaction.notify({
			type: "info",
			message: `The Claude Code copy at ${command} does not run on this machine. lunR will replace it with a fresh download.`,
		});
		// If removal fails (a Windows lock), the download below replaces the file anyway.
		await rm(command, { force: true }).catch(() => {});
	}
	const choice = await interaction.prompt({
		type: "select",
		message: `Download Claude Code ${CLAUDE_CODE_VERSION} (about 100 MB) from the npm registry into ${dirname(command)}? lunR checks it against a pinned hash and leaves any other Claude Code install alone.`,
		options: [
			{ id: "download", label: "Download Claude Code" },
			{ id: "cancel", label: "Cancel" },
		],
	});
	if (choice !== "download") throw new Error("Anthropic subscription setup cancelled");
	let reported = -1;
	await installClaudeCode(platform, command, {
		signal: interaction.signal,
		onProgress: (received, total) => {
			const step = total ? Math.floor((received / total) * 10) : Math.floor(received / 10_000_000);
			if (step === reported) return;
			reported = step;
			interaction.notify({
				type: "progress",
				message: total ? `Downloading Claude Code... ${step * 10}%` : `Downloading Claude Code... ${step * 10} MB`,
			});
		},
	});
	if (!(await claudeCodeRuns(command))) {
		// The next sign-in re-checks the file, so a failed removal still self-heals.
		await rm(command, { force: true }).catch(() => {});
		throw new Error("The downloaded Claude Code does not run on this machine. It was removed. Setup not saved.");
	}
	return command;
}

async function login(interaction: AuthInteraction): Promise<ExternalClaudeCodeCredential> {
	interaction.notify({
		type: "info",
		message: `lunR connects Claude Pro/Max through its own copy of Claude Code ${CLAUDE_CODE_VERSION}. Claude Code signs in and sends one generation per lunR request. lunR keeps tools, permissions, history, compaction, and subagents. If you already use Claude Code, its sign-in is reused. No credentials are copied into lunR.`,
	});
	const command = await ensureClaudeCode(interaction);
	// Claude Code keeps its sign-in under CLAUDE_CONFIG_DIR when set; every setup process and the saved record must agree.
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() ? process.env.CLAUDE_CONFIG_DIR : undefined;
	let status = await signInStatus(command, configDir);
	if (!status.subscribed) {
		if (!interaction.handoff)
			throw new Error(
				`Run "${command}" auth login in a terminal, sign in with a Claude subscription, then retry /login anthropic`,
			);
		const choice = await interaction.prompt({
			type: "select",
			message: "Claude Code needs a Claude subscription sign-in. Hand the terminal to Claude Code now?",
			options: [
				{ id: "login", label: "Run Claude Code sign-in" },
				{ id: "cancel", label: "Cancel" },
			],
		});
		if (choice !== "login") throw new Error("Anthropic subscription setup cancelled");
		await interaction.handoff(command, ["auth", "login"], claudeCodeEnvironment(configDir, false));
		status = await signInStatus(command, configDir);
		if (!status.subscribed) throw new Error("Claude Code is not signed in to a Claude subscription");
	}
	const models = await discoverModels(command, configDir);
	if (!models.length) throw new Error("Claude Code did not list any models lunR can use. Setup not saved.");
	return {
		type: "external_claude_code",
		version: 3,
		manager: "claude-code",
		command,
		...(configDir && { configDir }),
		accountFingerprint: status.accountFingerprint ?? randomUUID(),
		models,
	};
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic subscription through Claude Code",
	loginLabel: "Connect Claude Pro/Max through Claude Code",
	login,
	refresh: async () => {
		throw new Error("Legacy Anthropic OAuth tokens are unsupported. Run /login anthropic.");
	},
	toAuth: async () => {
		throw new Error("Legacy Anthropic OAuth tokens are unsupported. Run /login anthropic.");
	},
};
