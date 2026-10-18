/**
 * lunR: `lunr doctor` checks the local setup and prints one line per check, with a fix for
 * anything that needs attention. `lunr doctor keys` shows which shortcuts reach lunR from
 * the current terminal. Neither command prints credentials or changes any file.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isKeyRelease, ProcessTerminal, parseKey } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { getAgentDir, getDocsPath, isBunBinary, VERSION } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { type AppKeybinding, KeybindingsManager } from "../core/keybindings.ts";
import { officialCatalogCachePath } from "../core/official-catalog.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	status: DoctorStatus;
	label: string;
	detail: string;
	fix?: string;
}

const MIN_NODE = [22, 19] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns true when argv was `lunr doctor ...` and has been handled. */
export async function handleDoctorCli(args: string[]): Promise<boolean> {
	if (args[0] !== "doctor") return false;
	const sub = args[1];
	if (sub === "keys") {
		process.exitCode = await runKeyCheck();
	} else if (sub === undefined) {
		const checks = await collectDoctorChecks();
		console.log(formatDoctorReport(checks));
		process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
	} else {
		console.log(
			"Usage: lunr doctor        check logins, models, browser, Claude Code and gateway\n       lunr doctor keys   test which shortcuts reach lunR in this terminal",
		);
		process.exitCode = sub === "--help" || sub === "-h" || sub === "help" ? 0 : 2;
	}
	return true;
}

/** Runs every non-interactive check. Each check reports its own failure instead of throwing. */
export async function collectDoctorChecks(agentDir: string = getAgentDir()): Promise<DoctorCheck[]> {
	const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	const auth = AuthStorage.create(join(agentDir, "auth.json"));
	const logins = await auth.list();
	const checks = [
		checkNode(process.versions.node),
		checkAgentDir(agentDir),
		checkLogins(logins.map((login) => login.providerId)),
		checkDefaultModel(
			settings.getDefaultProvider(),
			settings.getDefaultModel(),
			logins.map((login) => login.providerId),
		),
		checkCatalog(officialCatalogCachePath(agentDir), Date.now()),
		await checkClaudeCode(auth),
		await checkBrowser(settings.getBrowserEnabled()),
		await checkGateway(),
		checkTerminal(process.env, getDocsPath()),
	];
	return checks.filter((check): check is DoctorCheck => check !== undefined);
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
	const mark = { ok: chalk.green("✓"), warn: chalk.yellow("!"), fail: chalk.red("✗") };
	const lines = [`lunR ${VERSION} doctor`, ""];
	for (const check of checks) {
		lines.push(`${mark[check.status]} ${chalk.bold(check.label)}: ${check.detail}`);
		if (check.fix) lines.push(`  ${chalk.dim(check.fix)}`);
	}
	const problems = checks.filter((check) => check.status !== "ok").length;
	lines.push(
		"",
		problems === 0 ? "Everything looks fine." : `${problems} item${problems === 1 ? " needs" : "s need"} attention.`,
	);
	return lines.join("\n");
}

export function checkNode(version: string): DoctorCheck {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
	return ok
		? { status: "ok", label: "Node.js", detail: version }
		: {
				status: "fail",
				label: "Node.js",
				detail: `${version} is too old`,
				fix: `Install Node.js ${MIN_NODE.join(".")} or newer.`,
			};
}

function checkAgentDir(agentDir: string): DoctorCheck {
	if (!existsSync(agentDir)) {
		return {
			status: "warn",
			label: "Config folder",
			detail: `${agentDir} does not exist yet`,
			fix: "Start lunr once to create it.",
		};
	}
	try {
		accessSync(agentDir, constants.W_OK);
		return { status: "ok", label: "Config folder", detail: agentDir };
	} catch {
		return {
			status: "fail",
			label: "Config folder",
			detail: `${agentDir} is not writable`,
			fix: "Fix the folder's permissions so lunR can save settings and sessions.",
		};
	}
}

export function checkLogins(providers: string[]): DoctorCheck {
	return providers.length > 0
		? { status: "ok", label: "Logins", detail: providers.join(", ") }
		: {
				status: "warn",
				label: "Logins",
				detail: "none saved",
				fix: "Run lunr, then /login to add a subscription or API key.",
			};
}

export function checkDefaultModel(
	provider: string | undefined,
	model: string | undefined,
	logins: string[],
): DoctorCheck {
	if (!provider || !model) {
		return { status: "warn", label: "Default model", detail: "not set", fix: "Pick one in lunr with /model." };
	}
	const name = `${provider}/${model}`;
	return logins.includes(provider)
		? { status: "ok", label: "Default model", detail: name }
		: {
				status: "warn",
				label: "Default model",
				detail: `${name}, but ${provider} has no saved login`,
				fix: `Run /login ${provider}, or set that provider's API key environment variable.`,
			};
}

export function checkCatalog(cachePath: string, now: number): DoctorCheck {
	if (!existsSync(cachePath)) {
		return {
			status: "ok",
			label: "Model catalog",
			detail: "using the catalog bundled with this version until the first refresh",
		};
	}
	const days = Math.floor((now - statSync(cachePath).mtimeMs) / DAY_MS);
	const age = days < 1 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
	return days > 14
		? {
				status: "warn",
				label: "Model catalog",
				detail: `last refreshed ${age}`,
				fix: "Run /refresh in lunr to check providers for new models.",
			}
		: { status: "ok", label: "Model catalog", detail: `last refreshed ${age}` };
}

async function checkClaudeCode(auth: AuthStorage): Promise<DoctorCheck | undefined> {
	const credential = await auth.read("anthropic");
	if (credential?.type !== "external_claude_code") return undefined;
	const label = "Claude subscription";
	if (credential.version < 3) {
		return {
			status: "fail",
			label,
			detail: "saved by an older lunR",
			fix: "Run /login anthropic once to set it up again.",
		};
	}
	if (!existsSync(credential.command)) {
		return {
			status: "fail",
			label,
			detail: `Claude Code is missing at ${credential.command}`,
			fix: "Run /login anthropic to install it again.",
		};
	}
	return { status: "ok", label, detail: `Claude Code at ${credential.command}` };
}

async function checkBrowser(enabled: boolean): Promise<DoctorCheck> {
	const label = "Browser";
	if (!enabled) return { status: "ok", label, detail: "off in /settings" };
	if (isBunBinary) {
		return { status: "ok", label, detail: "standalone build; Chromium comes from PLAYWRIGHT_BROWSERS_PATH" };
	}
	try {
		const { chromium } = await import("playwright-core");
		const path = chromium.executablePath();
		return existsSync(path)
			? { status: "ok", label, detail: "Chromium installed" }
			: {
					status: "fail",
					label,
					detail: "Chromium is not installed",
					fix: "Run lunr browser install, or turn Browser off in /settings.",
				};
	} catch (error) {
		return {
			status: "fail",
			label,
			detail: `browser runtime unavailable (${error instanceof Error ? error.message : String(error)})`,
			fix: "Reinstall lunR, then run lunr browser install.",
		};
	}
}

async function checkGateway(): Promise<DoctorCheck> {
	const label = "Gateway";
	const { loadGatewayConfig, resolvePlatformToken } = await import("../gateway/config.ts");
	const config = loadGatewayConfig();
	const platforms = (["telegram", "discord"] as const).filter((platform) => config[platform].enabled);
	if (platforms.length === 0) return { status: "ok", label, detail: "not set up" };
	const missing = platforms.filter((platform) => !resolvePlatformToken(platform, config[platform]));
	if (missing.length > 0) {
		return {
			status: "fail",
			label,
			detail: `${missing.join(", ")} has no bot token`,
			fix: "Run lunr gateway setup.",
		};
	}
	const { serviceStatusText } = await import("../gateway/service.ts");
	const state =
		serviceStatusText()
			.split("\n")[0]
			?.replace(/^Gateway:\s*/, "") ?? "unknown";
	const detail = `${platforms.join(" and ")}, ${state}`;
	if (state === "stopped")
		return { status: "warn", label, detail, fix: "Start it with lunr gateway start. Details: lunr gateway status." };
	if (state.includes("not responding")) return { status: "warn", label, detail, fix: "Inspect lunr gateway logs." };
	return { status: "ok", label, detail };
}

/** Terminal-specific shortcut traps from docs/terminal-setup.md, for the terminals lunR can recognize. */
export function checkTerminal(env: NodeJS.ProcessEnv, docsDir: string): DoctorCheck {
	const label = "Terminal";
	const setup = join(docsDir, "terminal-setup.md");
	const keysHint = "Run lunr doctor keys to test Shift+Enter, Alt+Enter and image paste.";
	if (env.TERM_PROGRAM === "vscode") {
		return {
			status: "ok",
			label,
			detail: "VS Code",
			fix: `VS Code keeps Alt+V and Ctrl+V for itself; use /paste-image or forward the key (${setup}). ${keysHint}`,
		};
	}
	if (env.WT_SESSION) {
		return {
			status: "ok",
			label,
			detail: "Windows Terminal",
			fix: `Alt+Enter toggles fullscreen by default; remap it to send the key to lunR (${setup}). ${keysHint}`,
		};
	}
	if (env.TMUX) {
		return {
			status: "ok",
			label,
			detail: "tmux",
			fix: `Enable extended keys so modified Enter reaches lunR (${join(docsDir, "tmux.md")}). ${keysHint}`,
		};
	}
	return { status: "ok", label, detail: env.TERM_PROGRAM ?? env.TERM ?? "unknown", fix: keysHint };
}

const KEY_TESTS: Array<{ action: AppKeybinding | "tui.input.newLine"; name: string }> = [
	{ action: "tui.input.newLine", name: "New line" },
	{ action: "app.message.followUp", name: "Queue follow-up" },
	{ action: "app.clipboard.pasteImage", name: "Paste image" },
];
const KEY_WAIT_MS = 15_000;

/** Interactive check: asks for each shortcut and reports what the terminal actually sent. */
async function runKeyCheck(): Promise<number> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		console.error("lunr doctor keys needs an interactive terminal.");
		return 2;
	}
	const keybindings = KeybindingsManager.create();
	const terminal = new ProcessTerminal();
	let pending: ((data: string | undefined) => void) | undefined;
	terminal.start(
		(data) => pending?.(data),
		() => {},
	);
	const say = (text: string) => terminal.write(`${text.replace(/\n/g, "\r\n")}\r\n`);
	let failed = 0;
	try {
		say("Press each shortcut when asked. Esc skips one; Ctrl+C stops.\n");
		for (const test of KEY_TESTS) {
			const keys = keybindings.getKeys(test.action);
			if (keys.length === 0) {
				say(`- ${test.name}: no key bound, skipped`);
				continue;
			}
			say(`${test.name}: press ${keys.join(" or ")}`);
			const data = await new Promise<string | undefined>((resolve) => {
				const timer = setTimeout(() => resolve(undefined), KEY_WAIT_MS);
				pending = (input) => {
					if (input !== undefined && isKeyRelease(input)) return;
					clearTimeout(timer);
					pending = undefined;
					resolve(input);
				};
			});
			if (data === "\x03") {
				say("Stopped.");
				return 130;
			}
			if (data !== undefined && keybindings.matches(data, test.action)) {
				say(`  ${chalk.green("✓")} received`);
			} else if (data === "\x1b") {
				say("  skipped");
			} else {
				failed++;
				const got = data === undefined ? "nothing arrived" : `got ${parseKey(data) ?? JSON.stringify(data)}`;
				say(
					`  ${chalk.red("✗")} ${got}. Your terminal or editor is keeping this key; see ${join(getDocsPath(), "terminal-setup.md")}.`,
				);
			}
		}
		say(
			failed === 0
				? "\nAll tested shortcuts reach lunR."
				: `\n${failed} shortcut${failed === 1 ? "" : "s"} did not reach lunR.`,
		);
		return failed === 0 ? 0 : 1;
	} finally {
		pending = undefined;
		await terminal.drainInput(300, 50);
		terminal.stop();
	}
}
