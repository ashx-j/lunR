/**
 * Product install CLI: setup / uninstall (no source).
 * Intercepted before handlePackageCommand so `lunr uninstall` (no source)
 * is product uninstall and `lunr uninstall <source>` stays package-remove.
 */

import { existsSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { APP_NAME, getAgentDir, NPM_CLI_PACKAGE, VERSION } from "../config.ts";
import { appendInstallLog, isProductUninstallArgv } from "../core/install-features.ts";
import { loadInstallLayout, resolveInstallPrefix } from "../core/install-layout.ts";

function printSetupHelp(): void {
	console.log(`${APP_NAME} setup [--yes]                   Install Chromium for the browser tool
${APP_NAME} uninstall [--purge] [--yes]    Remove this ${APP_NAME} install (keeps agent dir unless --purge)
${APP_NAME} uninstall <source> [-l]        Remove an extension package (alias for remove)
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

async function runSetup(argv: string[]): Promise<number> {
	const unknown = argv.find((arg) => arg !== "--yes" && arg !== "-y");
	if (unknown) {
		console.error(`unknown flag ${unknown}`);
		printSetupHelp();
		return 2;
	}
	const { installBrowser } = await import("../core/browser/setup.ts");
	await installBrowser(false);
	appendInstallLog(`setup installerVersion=${VERSION}`);
	console.log("\nNext:");
	console.log(`  1. Restart this shell (or add ${resolveInstallPrefix()}/bin to PATH)`);
	console.log(`  2. Run:  ${APP_NAME}`);
	console.log("  3. In the TUI:  /login");
	return 0;
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
			console.log(`sessions, auth, and settings kept in ${agentDir}`);
			console.log(`Add --purge to delete that directory.`);
		}
		if (!purge) appendInstallLog("uninstall npm purge=false");
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
				rmdirSync(prefix);
			} catch {
				// prefix may still hold unrelated files
			}
		}
		console.log(`purged ${agentDir}`);
	} else {
		console.log(`sessions, auth, and settings kept in ${agentDir}`);
	}
	console.log("Remove the PATH line from your shell profile if you added one.");
	if (!purge) appendInstallLog("uninstall purge=false");
	return 0;
}

/**
 * Returns true when this argv was an install-cli verb that we handled.
 * `uninstall <source>` and package-manager flags are not claimed.
 */
export async function handleInstallCli(args: string[]): Promise<boolean> {
	const [verb, ...rest] = args;
	if (verb === "browser") {
		if (rest.length !== 1 || rest[0] !== "install") {
			console.error("Usage: lunr browser install. Browser on/off is in /settings.");
			process.exitCode = 2;
		} else {
			const { installBrowser } = await import("../core/browser/setup.ts");
			await installBrowser();
		}
		return true;
	}
	if (verb === "setup") {
		process.exitCode = await runSetup(rest);
		return true;
	}
	if (verb === "uninstall" && isProductUninstallArgv(rest)) {
		process.exitCode = await runProductUninstall(rest);
		return true;
	}
	return false;
}
