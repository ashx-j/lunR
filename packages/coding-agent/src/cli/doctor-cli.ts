/**
 * lunR: `lunr doctor` checks the local setup and prints one line per check, with a fix for
 * anything that needs attention. `lunr doctor keys` shows which shortcuts reach lunR from
 * the current terminal. Neither command prints credentials or changes any file.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isKeyRelease, ProcessTerminal, parseKey } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { LOCAL_SERVERS } from "../builtin-extensions/lunr-local-providers/local-servers.ts";
import { getAgentDir, getDocsPath, isBunBinary, VERSION } from "../config.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { hasGrokCliXaiAuth } from "../core/grok-cli-auth.ts";
import { type AppKeybinding, KeybindingsManager } from "../core/keybindings.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
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
			"Usage: lunr doctor        check logins, models, browser and Claude Code\n       lunr doctor keys   test which shortcuts reach lunR in this terminal",
		);
		process.exitCode = sub === "--help" || sub === "-h" || sub === "help" ? 0 : 2;
	}
	return true;
}

/** Runs every non-interactive check. Each check reports its own failure instead of throwing. */
export async function collectDoctorChecks(agentDir: string = getAgentDir()): Promise<DoctorCheck[]> {
	const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
	const auth = AuthStorage.create(join(agentDir, "auth.json"));
	// Cache-only, like startup: no provider or catalog requests. `grokHome: null` keeps reads from
	// copying a Grok CLI login into auth.json; that login is checked directly instead.
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
		grokHome: null,
	});
	const ready = await readReadyProviders(runtime);
	if (!ready.some((provider) => provider.id === "xai") && hasGrokCliXaiAuth()) {
		ready.push({ id: "xai", kind: "login", detail: "Grok CLI" });
	}
	const loginIds = new Set([...runtime.getProviders().map((provider) => provider.id), ...LOCAL_SERVER_IDS]);
	const checks = [
		checkNode(process.versions.node),
		checkAgentDir(agentDir),
		...checkProviders(ready),
		checkDefaultModel(settings.getDefaultProvider(), settings.getDefaultModel(), ready, loginIds),
		checkCatalog(officialCatalogCachePath(agentDir), Date.now()),
		await checkClaudeCode(auth),
		await checkBrowser(settings.getBrowserEnabled()),
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

/** Where a ready provider's auth comes from. */
export type ProviderAuthKind = "login" | "local" | "env" | "custom";

export interface ReadyProvider {
	id: string;
	kind: ProviderAuthKind;
	/** Env variable names for `env`, or where a login lives, when known. */
	detail?: string;
}

const LOCAL_SERVER_IDS = LOCAL_SERVERS.map((server) => server.providerId);

/**
 * Providers the runtime can authenticate now. Uses the same test a prompt runs before its first
 * request (`hasConfiguredAuth` or `checkAuth` in agent-session), so env keys and models.json
 * providers count, not only saved logins.
 */
async function readReadyProviders(runtime: ModelRuntime): Promise<ReadyProvider[]> {
	const ids = new Set([
		...runtime.getProviders().map((provider) => provider.id),
		...(await runtime.listCredentials()).map((credential) => credential.providerId),
	]);
	const ready: ReadyProvider[] = [];
	for (const id of ids) {
		if (!runtime.hasConfiguredAuth(id) && (await runtime.checkAuth(id)) === undefined) continue;
		const status = runtime.getProviderAuthStatus(id);
		switch (status.source) {
			case "stored":
			case "runtime":
				ready.push({ id, kind: LOCAL_SERVER_IDS.includes(id) ? "local" : "login" });
				break;
			case "models_json_key":
			case "models_json_command":
			case "fallback":
				ready.push({ id, kind: "custom" });
				break;
			default:
				ready.push({ id, kind: "env", detail: status.label });
		}
	}
	return ready;
}

const PROVIDER_GROUPS: Array<{ kind: ProviderAuthKind; label: string }> = [
	{ kind: "login", label: "Saved logins" },
	{ kind: "env", label: "Environment keys" },
	{ kind: "custom", label: "Custom providers" },
	{ kind: "local", label: "Local servers" },
];

/** One line per kind of ready provider, or one warning when none is ready. */
export function checkProviders(ready: ReadyProvider[]): DoctorCheck[] {
	if (ready.length === 0) {
		return [
			{
				status: "warn",
				label: "Providers",
				detail: "none ready",
				fix: "Run lunr, then /login to add a subscription, API key or local server, or set a provider's API key environment variable.",
			},
		];
	}
	return PROVIDER_GROUPS.flatMap(({ kind, label }) => {
		const group = ready.filter((provider) => provider.kind === kind);
		if (group.length === 0) return [];
		const names = group.map((provider) => (provider.detail ? `${provider.id} (${provider.detail})` : provider.id));
		return [{ status: "ok", label, detail: names.join(", ") } satisfies DoctorCheck];
	});
}

/**
 * The saved default model and whether its provider is ready. `loginIds` are the providers /login
 * offers, so the fix never names a login that does not exist.
 */
export function checkDefaultModel(
	provider: string | undefined,
	model: string | undefined,
	ready: ReadyProvider[],
	loginIds: ReadonlySet<string>,
): DoctorCheck {
	const label = "Default model";
	if (!provider || !model) {
		return ready.length > 0
			? { status: "warn", label, detail: "not set", fix: "Pick one in lunr with /model." }
			: {
					status: "warn",
					label,
					detail: "not set",
					fix: "Add a provider first, then pick a model in lunr with /model.",
				};
	}
	const name = `${provider}/${model}`;
	if (ready.some((entry) => entry.id === provider)) return { status: "ok", label, detail: name };
	const local = LOCAL_SERVERS.find((server) => server.providerId === provider);
	const fix = local
		? `Start ${local.productName}, then run /login ${provider} in lunr.`
		: loginIds.has(provider)
			? `Run lunr, then /login ${provider}, or set that provider's API key environment variable.`
			: `${provider} is not a known provider. Pick another model in lunr with /model.`;
	return { status: "warn", label, detail: `${name}, but ${provider} has no key or login`, fix };
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
