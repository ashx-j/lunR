import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeCodeLoopback } from "../../api/claude-code-loopback.ts";
import { claudeCodeEnvironment, spawnClaudeCode, stopProcessTree } from "../../api/claude-code-process.ts";
import {
	CLAUDE_CODE_VERSION,
	claudeCodePlatform,
	claudeCodeRoute,
	installClaudeCode,
	managedClaudeCodePath,
} from "../../utils/claude-code-release.ts";
import type { AuthInteraction, ExternalClaudeCodeCredential, OAuthAuth } from "../types.ts";

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
async function signInStatus(command: string): Promise<{ subscribed: boolean; accountFingerprint?: string }> {
	let status: unknown;
	try {
		const output = await run(command, ["auth", "status"], { allowFailure: true });
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

/**
 * The account's model routes from Claude Code's own picker. The `initialize` handshake answers without a
 * Messages request; a relay that counts upstream calls proves that before anything is saved.
 */
async function discoverRoutes(command: string): Promise<string[]> {
	const loopback = await ClaudeCodeLoopback.open({ timeoutMs: 40_000 });
	const directory = await mkdtemp(join(tmpdir(), "lunr-claude-code-setup-"));
	try {
		const output = await run(
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
			{
				input: `${JSON.stringify({ type: "control_request", request_id: "lunr-picker", request: { subtype: "initialize" } })}\n`,
				env: { ...claudeCodeEnvironment(undefined, false), ANTHROPIC_BASE_URL: loopback.baseUrl },
				cwd: directory,
				timeoutMs: 40_000,
				allowFailure: true,
			},
		);
		if (loopback.admitted) throw new Error("Claude Code model discovery contacted Anthropic. Setup not saved.");
		const routes = new Set<string>();
		for (const line of output.split("\n")) {
			if (!line.startsWith("{")) continue;
			const event: unknown = JSON.parse(line);
			if (!isRecord(event) || event.type !== "control_response" || !isRecord(event.response)) continue;
			const reply = event.response.response;
			const rows: unknown[] = isRecord(reply) && Array.isArray(reply.models) ? reply.models : [];
			for (const row of rows) {
				if (!isRecord(row)) continue;
				const value = typeof row.resolvedModel === "string" && row.resolvedModel ? row.resolvedModel : row.value;
				const route = typeof value === "string" ? claudeCodeRoute(value) : undefined;
				if (route) routes.add(route);
			}
		}
		return [...routes];
	} finally {
		loopback.close();
		await rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}

/** Downloads lunR's pinned Claude Code after the user agrees, reporting progress in coarse steps. */
async function ensureClaudeCode(interaction: AuthInteraction): Promise<string> {
	const platform = claudeCodePlatform();
	if (!platform) throw new Error(`Claude Code ${CLAUDE_CODE_VERSION} has no build for ${process.platform} ${arch()}`);
	const command = managedClaudeCodePath(platform);
	if (existsSync(command)) return command;
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
	const version = await run(command, ["--version"]);
	if (!version.startsWith(CLAUDE_CODE_VERSION))
		throw new Error("The downloaded Claude Code does not run on this machine. Setup not saved.");
	return command;
}

async function login(interaction: AuthInteraction): Promise<ExternalClaudeCodeCredential> {
	interaction.notify({
		type: "info",
		message: `lunR connects Claude Pro/Max through its own copy of Claude Code ${CLAUDE_CODE_VERSION}. Claude Code signs in and sends one generation per lunR request. lunR keeps tools, permissions, history, compaction, and subagents. If you already use Claude Code, its sign-in is reused. No credentials are copied into lunR.`,
	});
	const command = await ensureClaudeCode(interaction);
	let status = await signInStatus(command);
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
		await interaction.handoff(command, ["auth", "login"], claudeCodeEnvironment(undefined, false));
		status = await signInStatus(command);
		if (!status.subscribed) throw new Error("Claude Code is not signed in to a Claude subscription");
	}
	const routes = await discoverRoutes(command);
	if (!routes.length) throw new Error("Claude Code did not list any models lunR can use. Setup not saved.");
	return {
		type: "external_claude_code",
		version: 2,
		manager: "claude-code",
		command,
		accountFingerprint: status.accountFingerprint ?? randomUUID(),
		routes,
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
