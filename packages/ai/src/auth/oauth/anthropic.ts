import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeEnvironment, stopNative } from "../../api/anthropic-claude-code-bridge.ts";
import type { AuthInteraction, ExternalClaudeCodeCredential, OAuthAuth } from "../types.ts";

const SETUP_WORKER = fileURLToPath(
	new URL("../../../vendor/hermes-claude-subscription-directsdk/lunr_setup_bridge.py", import.meta.url),
);
const VERSION = "2.1.263";

export function isQualifiedClaudeCodeVersion(value: string): boolean {
	return new RegExp(`^${VERSION.replaceAll(".", "\\.")}(?:\\s|$)`).test(value);
}

async function run(command: string, args: string[], input?: string, timeout = 25_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			detached: process.platform !== "win32",
			env: claudeCodeEnvironment(undefined, false),
		});
		let output = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void stopNative(child.pid ?? 0).finally(() => {
				child.kill();
				child.stdout.destroy();
				child.stdin.destroy();
				reject(new Error("Dependency check timed out"));
			});
		}, timeout);
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 64 * 1024) child.kill();
		});
		child.stdin.on("error", () => {});
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return;
			if (code !== 0) reject(new Error("Dependency check failed"));
			else resolve(output.trim());
		});
		child.stdin.end(input);
	});
}

async function executable(name: string): Promise<string | undefined> {
	const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	const directories = isAbsolute(name)
		? [""]
		: [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
	for (const directory of directories) {
		for (const suffix of suffixes) {
			const candidate = directory ? join(directory, `${name}${suffix}`) : `${name}${suffix}`;
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch {
				/* Next location. */
			}
		}
	}
	return undefined;
}

async function pythonInterpreter(): Promise<string | undefined> {
	for (const name of ["python3", "python"]) {
		const path = await executable(name);
		if (!path) continue;
		try {
			const version = await run(path, ["--version"]);
			const match = /^Python (\d+)\.(\d+)/.exec(version);
			if (match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10))) return path;
		} catch {
			/* Try another interpreter. */
		}
	}
	return undefined;
}

async function install(command: string, args: string[], interaction: AuthInteraction): Promise<void> {
	const confirm = await interaction.prompt({
		type: "select",
		message: `Run ${command} ${args.join(" ")}? This downloads software and changes your user-level system installation.`,
		options: [
			{ id: "yes", label: "Install" },
			{ id: "no", label: "Cancel" },
		],
	});
	if (confirm !== "yes") throw new Error("Anthropic subscription setup cancelled");
	interaction.notify({ type: "progress", message: "Running the confirmed installer..." });
	await run(command, args, undefined, 300_000);
}

async function setupProbe(python: string, command: string, type: "status" | "discover" | "version"): Promise<unknown> {
	const requestId = randomUUID();
	const line = await run(
		python,
		["-s", "-B", "-u", SETUP_WORKER],
		`${JSON.stringify({ v: 1, requestId, type, command, env: claudeCodeEnvironment(undefined, false) })}\n`,
		55_000,
	);
	const record: unknown = JSON.parse(line);
	if (
		!record ||
		typeof record !== "object" ||
		!("v" in record) ||
		record.v !== 1 ||
		!("requestId" in record) ||
		record.requestId !== requestId ||
		!("type" in record) ||
		record.type !== "result" ||
		!("result" in record)
	) {
		throw new Error("Invalid Claude Code setup response");
	}
	return record.result;
}

async function login(interaction: AuthInteraction): Promise<ExternalClaudeCodeCredential> {
	interaction.notify({
		type: "info",
		message:
			"Claude Code handles subscription authentication and one generation per lunR request. lunR still owns tools, permissions, history, compaction, and subagents. Python 3.10+ and Claude Code are required. No credentials are copied into lunR.",
	});
	let python = await pythonInterpreter();
	if (!python) {
		interaction.notify({
			type: "info",
			message:
				"Install Python 3.10+ from https://www.python.org/downloads/ . This is a separate operating-system installation, not part of lunR.",
		});
		const packageManager =
			process.platform === "darwin"
				? await executable("brew")
				: process.platform === "linux"
					? ((await executable("apt-get")) ?? (await executable("dnf")))
					: undefined;
		const installer =
			process.platform === "win32"
				? { command: "winget", args: ["install", "--id", "Python.Python.3.13", "-e"] }
				: packageManager?.endsWith("apt-get")
					? { command: "sudo", args: [packageManager, "install", "-y", "python3"] }
					: packageManager?.endsWith("dnf")
						? { command: "sudo", args: [packageManager, "install", "-y", "python3"] }
						: packageManager
							? { command: packageManager, args: ["install", "python@3.13"] }
							: undefined;
		const choice = await interaction.prompt({
			type: "select",
			message:
				"Python 3.10+ is missing. A system installer may request administrator access and change your machine.",
			options: [
				...(installer
					? [{ id: "install", label: `Install through ${installer.command} ${installer.args.join(" ")}` }]
					: []),
				{ id: "cancel", label: "Cancel and install Python yourself" },
			],
		});
		if (choice === "install" && installer) await install(installer.command, installer.args, interaction);
		else throw new Error("Install Python 3.10+ and retry /login anthropic");
		python = await pythonInterpreter();
		if (!python)
			throw new Error("Python installation finished but the interpreter is not on PATH. Restart lunR and retry.");
	}
	let command = await executable("claude");
	if (!command) {
		const choice = await interaction.prompt({
			type: "select",
			message: "Claude Code is missing. Installation changes your user-level system and may require a new PATH.",
			options: [
				{ id: "install", label: "Install Claude Code" },
				{ id: "existing", label: "Use existing executable" },
				{ id: "cancel", label: "Cancel" },
			],
		});
		if (choice === "install") {
			if (process.platform === "win32")
				await install(
					"powershell",
					["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"],
					interaction,
				);
			else await install("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], interaction);
			command = await executable("claude");
		} else if (choice === "existing") {
			const path = await interaction.prompt({ type: "text", message: "Absolute path to Claude Code executable:" });
			if (!isAbsolute(path)) throw new Error("Claude Code path must be absolute");
			command = await executable(path);
		} else throw new Error("Anthropic subscription setup cancelled");
	}
	if (!command) throw new Error("Claude Code executable not found. Restart lunR after installation and retry.");
	const version = (await setupProbe(python, command, "version")) as string;
	if (!isQualifiedClaudeCodeVersion(version))
		throw new Error(
			`Claude Code ${VERSION} is the only qualified version. Found ${version.slice(0, 40)}. Subscription requests are disabled until this version is qualified.`,
		);
	let status = (await setupProbe(python, command, "status")) as {
		logged_in?: boolean;
		plan?: string;
		accountFingerprint?: string;
	};
	if (!status.logged_in || !/Claude (Pro|Max|Team|Enterprise)/i.test(status.plan ?? "")) {
		if (!interaction.handoff)
			throw new Error(
				`Run "${command}" auth login in a terminal, select a Claude subscription, then retry /login anthropic`,
			);
		const choice = await interaction.prompt({
			type: "select",
			message: "Claude Code needs a subscription login. Hand the terminal to Claude Code now?",
			options: [
				{ id: "login", label: "Run Claude Code login" },
				{ id: "cancel", label: "Cancel" },
			],
		});
		if (choice !== "login") throw new Error("Anthropic subscription setup cancelled");
		await interaction.handoff(
			python,
			["-s", "-B", "-u", SETUP_WORKER, "auth-login", command],
			claudeCodeEnvironment(undefined, false),
		);
		status = (await setupProbe(python, command, "status")) as typeof status;
		if (!status.logged_in || !/Claude (Pro|Max|Team|Enterprise)/i.test(status.plan ?? ""))
			throw new Error("Claude Code is not signed into a Claude subscription");
	}
	const discovered = await setupProbe(python, command, "discover");
	if (
		!Array.isArray(discovered) ||
		!discovered.length ||
		discovered.some((row) => !row || typeof row.id !== "string" || row.upstream_requests !== 0)
	) {
		throw new Error("Claude Code model discovery did not verify zero Messages requests. Setup not saved.");
	}
	return {
		type: "external_claude_code",
		version: 1,
		manager: "claude-code",
		command,
		python,
		accountFingerprint: status.accountFingerprint ?? randomUUID(),
		routes: discovered.map((row) => row.id),
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
