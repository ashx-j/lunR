/**
 * Install-time feature catalog. Persistence is ~/.lunr/agent/install-features.json
 * (getAgentDir()). Secrets never land here — they go to gateway.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendDebugLog, getAgentDir, VERSION } from "../config.ts";
import { loadGatewayConfig, saveGatewayConfig } from "../gateway/config.ts";

export type FeatureId = "chat-platforms";

export interface FeatureOptionSpec {
	id: string;
	type: "boolean" | "secret";
	prompt: string;
	default?: boolean;
	askWhen?: FeatureId;
}

export interface FeatureSpec {
	id: FeatureId;
	title: string;
	summary: string;
	defaultEnabled: boolean;
	options: FeatureOptionSpec[];
}

export const FEATURE_CATALOG: FeatureSpec[] = [
	{
		id: "chat-platforms",
		title: "Chat platforms",
		summary: "Discord + Telegram gateway so lunR can talk in chat apps.",
		defaultEnabled: false,
		options: [
			{
				id: "autostart",
				type: "boolean",
				prompt: "Auto-start the lunR gateway daemon when you log in?",
				default: false,
				askWhen: "chat-platforms",
			},
			{
				id: "telegram-token",
				type: "secret",
				prompt: "Telegram bot token (empty skips; stored in gateway.json)",
				askWhen: "chat-platforms",
			},
			{
				id: "discord-token",
				type: "secret",
				prompt: "Discord bot token (empty skips; stored in gateway.json)",
				askWhen: "chat-platforms",
			},
		],
	},
];

export interface InstalledFeatureState {
	enabled: boolean;
	options: Record<string, boolean | string | number>;
}

export interface InstallFeaturesFile {
	schemaVersion: 1;
	installerVersion: string;
	installMethod: "binary";
	installedAt: string;
	updatedAt: string;
	inferUntil?: string;
	features: Record<string, InstalledFeatureState>;
}

export const CHAT_PLATFORMS_INFER_UNTIL = "0.2.0";

export function installFeaturesPath(): string {
	return join(getAgentDir(), "install-features.json");
}

export function getFeatureSpec(id: string): FeatureSpec | undefined {
	return FEATURE_CATALOG.find((f) => f.id === id);
}

export function getFeatureOptionSpec(id: string, option: string): FeatureOptionSpec | undefined {
	return getFeatureSpec(id)?.options.find((o) => o.id === option);
}

/** Compare x.y.z; missing parts count as 0. */
export function versionGte(a: string, b: string): boolean {
	const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
	const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

function emptyFile(now = new Date().toISOString()): InstallFeaturesFile {
	return {
		schemaVersion: 1,
		installerVersion: VERSION,
		installMethod: "binary",
		installedAt: now,
		updatedAt: now,
		features: {},
	};
}

function sanitizeState(raw: unknown): InstalledFeatureState | undefined {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.enabled !== "boolean") return undefined;
	const options: Record<string, boolean | string | number> = {};
	if (r.options != null && typeof r.options === "object" && !Array.isArray(r.options)) {
		for (const [k, v] of Object.entries(r.options as Record<string, unknown>)) {
			if (typeof v === "boolean" || typeof v === "string" || typeof v === "number") {
				options[k] = v;
			}
		}
	}
	return { enabled: r.enabled, options };
}

function sanitizeFile(raw: unknown): InstallFeaturesFile | undefined {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.schemaVersion !== 1) return undefined;
	const features: Record<string, InstalledFeatureState> = {};
	if (r.features != null && typeof r.features === "object" && !Array.isArray(r.features)) {
		for (const [id, state] of Object.entries(r.features as Record<string, unknown>)) {
			const sanitized = sanitizeState(state);
			if (sanitized) features[id] = sanitized;
		}
	}
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		installerVersion: typeof r.installerVersion === "string" ? r.installerVersion : VERSION,
		installMethod: "binary",
		installedAt: typeof r.installedAt === "string" ? r.installedAt : now,
		updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
		inferUntil: typeof r.inferUntil === "string" ? r.inferUntil : undefined,
		features,
	};
}

/** True when gateway.json has at least one platform enabled with a file token. */
export function gatewayHasEnabledFileToken(): boolean {
	const cfg = loadGatewayConfig();
	for (const platform of [cfg.telegram, cfg.discord]) {
		if (platform.enabled && typeof platform.token === "string" && platform.token.length > 0) {
			return true;
		}
	}
	return false;
}

function inferPathActive(): boolean {
	// Pre-public 0.80.x is numerically > 0.2.0; still infer so dogfooders work
	// until PR 7 rewrites the version line to 0.1.0.
	if (VERSION.startsWith("0.80.")) return true;
	return !versionGte(VERSION, CHAT_PLATFORMS_INFER_UNTIL);
}

function inferFromGateway(): InstallFeaturesFile | undefined {
	if (!inferPathActive()) return undefined;
	if (!gatewayHasEnabledFileToken()) return undefined;
	const now = new Date().toISOString();
	const file: InstallFeaturesFile = {
		...emptyFile(now),
		inferUntil: CHAT_PLATFORMS_INFER_UNTIL,
		features: {
			"chat-platforms": { enabled: true, options: { autostart: false } },
		},
	};
	saveInstallFeatures(file);
	appendDebugLog("install-features: inferred chat-platforms enabled (file token, autostart false)");
	return file;
}

export function loadInstallFeatures(): InstallFeaturesFile {
	const path = installFeaturesPath();
	if (!existsSync(path)) {
		return inferFromGateway() ?? emptyFile();
	}
	try {
		const parsed = sanitizeFile(JSON.parse(readFileSync(path, "utf-8")));
		return parsed ?? inferFromGateway() ?? emptyFile();
	} catch {
		return inferFromGateway() ?? emptyFile();
	}
}

export function saveInstallFeatures(file: InstallFeaturesFile): void {
	const path = installFeaturesPath();
	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
	try {
		chmodSync(path, 0o644);
	} catch {
		// best-effort (Windows ACLs)
	}
}

export function isFeatureEnabled(id: FeatureId): boolean {
	const file = loadInstallFeatures();
	const state = file.features[id];
	if (state) return state.enabled;
	return getFeatureSpec(id)?.defaultEnabled ?? false;
}

export function getFeatureOption(id: FeatureId, option: string): unknown {
	return loadInstallFeatures().features[id]?.options[option];
}

export function coerceBooleanSetValue(raw: string): boolean | undefined {
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return undefined;
}

export interface ParsedSet {
	id: string;
	option: string;
	value: string;
}

export function parseSetAssignment(raw: string): ParsedSet | undefined {
	const eq = raw.indexOf("=");
	if (eq <= 0) return undefined;
	const lhs = raw.slice(0, eq);
	const value = raw.slice(eq + 1);
	const dot = lhs.indexOf(".");
	if (dot <= 0 || dot === lhs.length - 1) return undefined;
	return { id: lhs.slice(0, dot), option: lhs.slice(dot + 1), value };
}

export type SetupParseResult =
	| {
			ok: true;
			yes: boolean;
			reconfigure: boolean;
			features: string[];
			noFeatures: string[];
			sets: ParsedSet[];
	  }
	| { ok: false; error: string };

/** Parse setup / features-enable flags. Unknown flags are an error. */
export function parseFeatureFlags(argv: string[]): SetupParseResult {
	let yes = false;
	let reconfigure = false;
	const features: string[] = [];
	const noFeatures: string[] = [];
	const sets: ParsedSet[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--yes" || arg === "-y") {
			yes = true;
			continue;
		}
		if (arg === "--reconfigure") {
			reconfigure = true;
			continue;
		}
		if (arg === "--feature") {
			const id = argv[++i];
			if (!id) return { ok: false, error: "--feature requires an id" };
			features.push(id);
			continue;
		}
		if (arg === "--no-feature") {
			const id = argv[++i];
			if (!id) return { ok: false, error: "--no-feature requires an id" };
			noFeatures.push(id);
			continue;
		}
		if (arg === "--set") {
			const raw = argv[++i];
			if (!raw) return { ok: false, error: "--set requires <id.option>=<value>" };
			const parsed = parseSetAssignment(raw);
			if (!parsed) return { ok: false, error: `invalid --set ${raw}` };
			sets.push(parsed);
			continue;
		}
		if (arg.startsWith("--feature=")) {
			features.push(arg.slice("--feature=".length));
			continue;
		}
		if (arg.startsWith("--no-feature=")) {
			noFeatures.push(arg.slice("--no-feature=".length));
			continue;
		}
		if (arg.startsWith("--set=")) {
			const parsed = parseSetAssignment(arg.slice("--set=".length));
			if (!parsed) return { ok: false, error: `invalid --set ${arg}` };
			sets.push(parsed);
			continue;
		}
		return { ok: false, error: `unknown flag ${arg}` };
	}

	return { ok: true, yes, reconfigure, features, noFeatures, sets };
}

export type ApplyFlagsError = { ok: false; error: string; exitCode: 2 };
export type ApplyFlagsOk = {
	ok: true;
	next: InstallFeaturesFile;
	secrets: Record<string, string>;
	enabledIds: FeatureId[];
	disabledIds: FeatureId[];
};

/**
 * Validate --feature / --no-feature / --set against the catalog and produce
 * the next install-features.json. Secret --set is rejected. --set on a
 * feature that is not being enabled this invocation is rejected.
 */
export function applyFeatureFlags(
	current: InstallFeaturesFile,
	flags: Extract<SetupParseResult, { ok: true }>,
): ApplyFlagsOk | ApplyFlagsError {
	const next: InstallFeaturesFile = {
		...current,
		installerVersion: VERSION,
		updatedAt: new Date().toISOString(),
		features: { ...current.features },
	};
	const secrets: Record<string, string> = {};
	const enabledIds: FeatureId[] = [];
	const disabledIds: FeatureId[] = [];

	for (const id of flags.features) {
		if (!getFeatureSpec(id)) return { ok: false, error: `unknown feature ${id}`, exitCode: 2 };
		const prev = next.features[id];
		next.features[id] = { enabled: true, options: { ...prev?.options } };
		enabledIds.push(id as FeatureId);
	}
	for (const id of flags.noFeatures) {
		if (!getFeatureSpec(id)) return { ok: false, error: `unknown feature ${id}`, exitCode: 2 };
		const prev = next.features[id];
		next.features[id] = { enabled: false, options: { ...prev?.options } };
		disabledIds.push(id as FeatureId);
	}

	for (const set of flags.sets) {
		const spec = getFeatureSpec(set.id);
		if (!spec) return { ok: false, error: `unknown feature ${set.id}`, exitCode: 2 };
		const option = getFeatureOptionSpec(set.id, set.option);
		if (!option) return { ok: false, error: `unknown option ${set.id}.${set.option}`, exitCode: 2 };
		if (option.type === "secret") {
			return {
				ok: false,
				error: `cannot --set a secret option (${set.id}.${set.option}). set LUNR_TELEGRAM_BOT_TOKEN / LUNR_DISCORD_BOT_TOKEN, or run setup in a TTY`,
				exitCode: 2,
			};
		}
		const enablingNow = flags.features.includes(set.id) || next.features[set.id]?.enabled === true;
		if (!enablingNow) {
			return { ok: false, error: `enable the feature first (${set.id})`, exitCode: 2 };
		}
		if (option.type === "boolean") {
			const coerced = coerceBooleanSetValue(set.value);
			if (coerced === undefined) {
				return { ok: false, error: `${set.id}.${set.option} must be true|false|1|0`, exitCode: 2 };
			}
			const prev = next.features[set.id] ?? { enabled: true, options: {} };
			next.features[set.id] = { ...prev, enabled: true, options: { ...prev.options, [set.option]: coerced } };
		}
	}

	return { ok: true, next, secrets, enabledIds, disabledIds };
}

export interface FeatureApplyContext {
	previous: InstalledFeatureState | undefined;
	next: InstalledFeatureState;
	secrets: Record<string, string>;
	nonInteractive: boolean;
}

export interface FeatureHandler {
	apply(ctx: FeatureApplyContext): Promise<void>;
	disable(opts: { purgeSecrets: boolean }): Promise<void>;
}

function persistEnvAndSecretTokens(secrets: Record<string, string>): void {
	const cfg = loadGatewayConfig();
	const telegram = secrets["telegram-token"] || process.env.LUNR_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
	const discord = secrets["discord-token"] || process.env.LUNR_DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
	if (telegram) {
		cfg.telegram.token = telegram;
		cfg.telegram.enabled = true;
	}
	if (discord) {
		cfg.discord.token = discord;
		cfg.discord.enabled = true;
	}
	saveGatewayConfig(cfg);
}

export const chatPlatformsHandler: FeatureHandler = {
	async apply(ctx) {
		persistEnvAndSecretTokens(ctx.secrets);
		const cfg = loadGatewayConfig();
		if (cfg.telegram.token) cfg.telegram.enabled = true;
		if (cfg.discord.token) cfg.discord.enabled = true;
		saveGatewayConfig(cfg);
		// Autostart OS units land in a follow-up PR. The option is persisted.
		if (ctx.next.options.autostart === true) {
			const hasFileToken = Boolean(cfg.telegram.token || cfg.discord.token);
			if (!hasFileToken) {
				console.error("chat-platforms: autostart requested but no file token in gateway.json — unit not enabled.");
			} else {
				console.error("chat-platforms: autostart recorded; login item install is not in this build yet.");
			}
		}
	},
	async disable(opts) {
		const cfg = loadGatewayConfig();
		cfg.telegram.enabled = false;
		cfg.discord.enabled = false;
		if (opts.purgeSecrets) {
			delete cfg.telegram.token;
			delete cfg.discord.token;
		}
		saveGatewayConfig(cfg);
	},
};

export const FEATURE_HANDLERS: Record<FeatureId, FeatureHandler> = {
	"chat-platforms": chatPlatformsHandler,
};

export function appendInstallLog(line: string): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const path = join(dir, "install.log");
		writeFileSync(path, `${new Date().toISOString()} ${line}\n`, { encoding: "utf-8", flag: "a" });
	} catch {
		// best-effort
	}
}

export const PRODUCT_UNINSTALL_FLAGS = new Set(["--purge", "--yes", "-y"]);

/** Product uninstall only when every remaining argv is empty or a product flag. */
export function isProductUninstallArgv(rest: string[]): boolean {
	return rest.every((arg) => PRODUCT_UNINSTALL_FLAGS.has(arg));
}

export function deliverMentionsChatPlatform(deliver: string): boolean {
	return deliver.split(",").some((part) => {
		const name = part.trim().split(":")[0]?.toLowerCase();
		return name === "telegram" || name === "discord";
	});
}

export function chatPlatformDeliverBlockedMessage(): string {
	return "chat platforms are not enabled. Enable with: lunr features enable chat-platforms";
}
