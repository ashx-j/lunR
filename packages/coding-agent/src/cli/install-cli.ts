/**
 * Product install CLI: setup / features / uninstall (no source).
 * Intercepted before handlePackageCommand so `lunr uninstall` (no source)
 * is product uninstall and `lunr uninstall <source>` stays package-remove.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { APP_NAME, getAgentDir, NPM_CLI_PACKAGE, VERSION } from "../config.ts";
import {
	appendInstallLog,
	applyFeatureFlags,
	FEATURE_CATALOG,
	FEATURE_HANDLERS,
	type FeatureId,
	getFeatureSpec,
	type InstallFeaturesFile,
	isProductUninstallArgv,
	loadInstallFeatures,
	parseFeatureFlags,
	saveInstallFeatures,
} from "../core/install-features.ts";
import { loadInstallLayout, resolveInstallPrefix } from "../core/install-layout.ts";
import { loadGatewayConfig } from "../gateway/config.ts";
import { readSecret } from "./read-secret.ts";

function printSetupHelp(): void {
	console.log(`${APP_NAME} setup [--yes] [--feature <id>] [--no-feature <id>] [--set <id.option>=<value>] [--reconfigure]

First-run / reconfigure optional features.

${APP_NAME} features list
${APP_NAME} features enable <id> [--set <id.option>=<value>]...
${APP_NAME} features disable <id> [--purge-secrets]
${APP_NAME} uninstall [--purge] [--yes]    Remove this ${APP_NAME} install (keeps agent dir unless --purge)
${APP_NAME} uninstall <source> [-l]        Remove an extension package (alias for remove)
`);
}

function printFeaturesHelp(): void {
	console.log(`${APP_NAME} features list
${APP_NAME} features enable <id> [--set <id.option>=<value>]...
${APP_NAME} features disable <id> [--purge-secrets]
`);
}

async function askYesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
	if (!process.stdin.isTTY) return defaultYes;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const suffix = defaultYes ? "[Y/n]" : "[y/N]";
	const answer = await new Promise<string>((resolve) => {
		rl.question(`${prompt} ${suffix} `, resolve);
	});
	rl.close();
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === "") return defaultYes;
	return trimmed === "y" || trimmed === "yes";
}

function fileTokenAlreadySet(optionId: string): boolean {
	const cfg = loadGatewayConfig();
	if (optionId === "telegram-token") return Boolean(cfg.telegram.token);
	if (optionId === "discord-token") return Boolean(cfg.discord.token);
	return false;
}

async function collectSecretsForFeature(id: FeatureId, secrets: Record<string, string>): Promise<void> {
	const spec = getFeatureSpec(id);
	if (!spec) return;
	for (const option of spec.options) {
		if (option.type !== "secret") continue;
		if (fileTokenAlreadySet(option.id)) {
			console.log(`    ${option.id}: token already set`);
			continue;
		}
		const value = await readSecret(option.prompt);
		if (value) secrets[option.id] = value;
	}
}

async function runSetup(argv: string[]): Promise<number> {
	const parsed = parseFeatureFlags(argv);
	if (!parsed.ok) {
		console.error(parsed.error);
		printSetupHelp();
		return 2;
	}
	if (!parsed.yes && !process.stdin.isTTY) {
		console.error("non-interactive setup requires --yes");
		printSetupHelp();
		return 2;
	}

	const current = loadInstallFeatures();
	let next = current;
	const secrets: Record<string, string> = {};

	if (parsed.yes) {
		const applied = applyFeatureFlags(current, parsed);
		if (!applied.ok) {
			console.error(applied.error);
			return applied.exitCode;
		}
		next = applied.next;
		for (const id of applied.enabledIds) {
			const prev = current.features[id];
			const state = next.features[id];
			if (state) {
				await FEATURE_HANDLERS[id].apply({
					previous: prev,
					next: state,
					secrets: applied.secrets,
					nonInteractive: true,
				});
			}
		}
		for (const id of applied.disabledIds) {
			await FEATURE_HANDLERS[id].disable({ purgeSecrets: false });
		}
	} else {
		console.log(`lunR ${VERSION} setup\n`);
		const layout = loadInstallLayout();
		if (layout) {
			console.log(`Install location:  ${join(layout.prefix, "versions", layout.version)}`);
			console.log(`Command:           ${layout.argv0}\n`);
		}
		console.log("Optional features");
		for (const spec of FEATURE_CATALOG) {
			const existing = current.features[spec.id];
			const defaultEnabled = existing?.enabled ?? spec.defaultEnabled;
			console.log(`  ${spec.title}`);
			console.log(`    ${spec.summary}`);
			const enable = await askYesNo("    Enable?", defaultEnabled);
			next.features[spec.id] = {
				enabled: enable,
				options: { ...existing?.options },
			};
			if (!enable) {
				await FEATURE_HANDLERS[spec.id].disable({ purgeSecrets: false });
				continue;
			}
			for (const option of spec.options) {
				if (option.type === "boolean") {
					const currentBool =
						typeof existing?.options[option.id] === "boolean"
							? (existing.options[option.id] as boolean)
							: (option.default ?? false);
					const value = await askYesNo(`    ${option.prompt}`, currentBool);
					next.features[spec.id].options[option.id] = value;
				}
			}
			await collectSecretsForFeature(spec.id, secrets);
			await FEATURE_HANDLERS[spec.id].apply({
				previous: existing,
				next: next.features[spec.id],
				secrets,
				nonInteractive: false,
			});
		}
		next = {
			...next,
			installerVersion: VERSION,
			updatedAt: new Date().toISOString(),
			installedAt: next.installedAt || new Date().toISOString(),
		};
	}

	saveInstallFeatures(next);
	appendInstallLog(`setup installerVersion=${VERSION}`);
	console.log(`Writing ${getAgentDir()}/install-features.json`);
	console.log("\nNext:");
	console.log(`  1. Restart this shell (or add ${resolveInstallPrefix()}/bin to PATH)`);
	console.log(`  2. Run:  ${APP_NAME}`);
	console.log("  3. In the TUI:  /login");
	return 0;
}

async function runFeatures(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	if (!sub || sub === "list") {
		const file = loadInstallFeatures();
		for (const spec of FEATURE_CATALOG) {
			const enabled = file.features[spec.id]?.enabled ?? spec.defaultEnabled;
			console.log(`${spec.id}: ${enabled ? "enabled" : "disabled"}  — ${spec.summary}`);
		}
		return 0;
	}
	if (sub === "enable") {
		const id = rest[0];
		if (!id || !getFeatureSpec(id)) {
			console.error(id ? `unknown feature ${id}` : "features enable requires an id");
			printFeaturesHelp();
			return 2;
		}
		const flagArgv = ["--feature", id, ...rest.slice(1)];
		const parsed = parseFeatureFlags(flagArgv);
		if (!parsed.ok) {
			console.error(parsed.error);
			return 2;
		}
		if (!parsed.yes && !process.stdin.isTTY && rest.slice(1).length === 0) {
			// --yes not required: enable with catalog defaults when non-interactive
		}
		const current = loadInstallFeatures();
		const applied = applyFeatureFlags(current, parsed);
		if (!applied.ok) {
			console.error(applied.error);
			return applied.exitCode;
		}
		const secrets: Record<string, string> = { ...applied.secrets };
		if (process.stdin.isTTY && !parsed.yes) {
			const spec = getFeatureSpec(id);
			if (spec) {
				for (const option of spec.options) {
					if (option.type !== "boolean") continue;
					if (applied.next.features[id]?.options[option.id] !== undefined) continue;
					const currentBool =
						typeof current.features[id]?.options[option.id] === "boolean"
							? (current.features[id].options[option.id] as boolean)
							: (option.default ?? false);
					const value = await askYesNo(`  ${option.prompt}`, currentBool);
					const state = applied.next.features[id] ?? { enabled: true, options: {} };
					state.options[option.id] = value;
					applied.next.features[id] = state;
				}
				await collectSecretsForFeature(id as FeatureId, secrets);
			}
		}
		const state = applied.next.features[id];
		if (state) {
			await FEATURE_HANDLERS[id as FeatureId].apply({
				previous: current.features[id],
				next: state,
				secrets,
				nonInteractive: parsed.yes || !process.stdin.isTTY,
			});
		}
		saveInstallFeatures(applied.next);
		appendInstallLog(`features enable ${id}`);
		console.log(`enabled ${id}`);
		return 0;
	}
	if (sub === "disable") {
		const id = rest[0];
		if (!id || !getFeatureSpec(id)) {
			console.error(id ? `unknown feature ${id}` : "features disable requires an id");
			printFeaturesHelp();
			return 2;
		}
		const purgeSecrets = rest.includes("--purge-secrets");
		const current = loadInstallFeatures();
		const prev = current.features[id];
		current.features[id] = { enabled: false, options: { ...prev?.options } };
		current.updatedAt = new Date().toISOString();
		await FEATURE_HANDLERS[id as FeatureId].disable({ purgeSecrets });
		saveInstallFeatures(current);
		appendInstallLog(`features disable ${id}`);
		console.log(`disabled ${id}`);
		return 0;
	}
	if (sub === "--help" || sub === "-h") {
		printFeaturesHelp();
		return 0;
	}
	console.error(`unknown features subcommand ${sub}`);
	printFeaturesHelp();
	return 2;
}

function parseUninstallFlags(argv: string[]): { purge: boolean; yes: boolean } {
	return {
		purge: argv.includes("--purge"),
		yes: argv.includes("--yes") || argv.includes("-y"),
	};
}

function isBinaryLayoutInstall(): boolean {
	return loadInstallLayout() !== undefined;
}

async function runProductUninstall(argv: string[]): Promise<number> {
	const { purge, yes } = parseUninstallFlags(argv);
	const agentDir = getAgentDir();

	if (!isBinaryLayoutInstall()) {
		console.log(`This looks like an npm install. Remove the CLI with:`);
		console.log(`  npm rm -g ${NPM_CLI_PACKAGE}`);
		if (purge) {
			if (!yes && !process.stdin.isTTY) {
				console.error("non-interactive --purge requires --yes");
				return 2;
			}
			if (!yes) {
				const ok = await askYesNo(`Also delete ${agentDir}? This cannot be undone.`, false);
				if (!ok) {
					console.log("aborted");
					return 1;
				}
			}
			if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
			console.log(`purged ${agentDir}`);
		} else {
			console.log(`sessions, auth, and gateway config kept in ${agentDir}`);
			console.log(`Add --purge to delete that directory.`);
		}
		appendInstallLog(`uninstall npm purge=${purge}`);
		return 0;
	}

	const prefix = resolveInstallPrefix();

	if (purge && !yes) {
		if (!process.stdin.isTTY) {
			console.error("non-interactive --purge requires --yes");
			return 2;
		}
		const ok = await askYesNo(`Delete ${prefix} and ${agentDir}? This cannot be undone.`, false);
		if (!ok) {
			console.log("aborted");
			return 1;
		}
	}

	const versions = join(prefix, "versions");
	const bin = join(prefix, "bin");
	if (existsSync(versions)) rmSync(versions, { recursive: true, force: true });
	if (existsSync(bin)) rmSync(bin, { recursive: true, force: true });
	console.log(`removed ${versions} and ${bin}`);

	if (purge) {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
		if (existsSync(prefix)) {
			try {
				rmSync(prefix, { recursive: true, force: true });
			} catch {
				// prefix may still hold unrelated files
			}
		}
		console.log(`purged ${agentDir}`);
	} else {
		console.log(`sessions, auth, and gateway config kept in ${agentDir}`);
	}
	console.log("Remove the PATH line from your shell profile if you added one.");
	appendInstallLog(`uninstall purge=${purge}`);
	return 0;
}

/**
 * Returns true when this argv was an install-cli verb that we handled.
 * `uninstall <source>` and package-manager flags are not claimed.
 */
export async function handleInstallCli(args: string[]): Promise<boolean> {
	const [verb, ...rest] = args;
	if (verb === "setup") {
		process.exitCode = await runSetup(rest);
		return true;
	}
	if (verb === "features") {
		process.exitCode = await runFeatures(rest);
		return true;
	}
	if (verb === "uninstall" && isProductUninstallArgv(rest)) {
		process.exitCode = await runProductUninstall(rest);
		return true;
	}
	return false;
}

export type { InstallFeaturesFile };
