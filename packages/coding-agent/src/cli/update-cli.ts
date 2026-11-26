/**
 * `lunr update` / `lunr update --self` — reinstall the published global CLI.
 * Workspace checkouts (this repo's npx lunr) refuse to self-update.
 */

import chalk from "chalk";
import { APP_NAME, getAgentDir, getPackageDir, NPM_CLI_PACKAGE, PACKAGE_NAME, VERSION } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { checkForUpdate, isPublishedInstall } from "../core/update-check.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";

function printUpdateHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${APP_NAME} update [--self]

Reinstall the global ${NPM_CLI_PACKAGE} package from npm.

Options:
  --self    Same as \`${APP_NAME} update\` (kept for muscle memory)
  -h, --help

This does not refresh model catalogs (/refresh) or extension packages (${APP_NAME} install).
`);
}

export async function handleUpdateCli(
	args: string[],
	deps: {
		check?: typeof checkForUpdate;
		spawn?: (command: string, argv: string[]) => Promise<number | null>;
		published?: boolean;
		currentVersion?: string;
		warn?: (msg: string) => void;
		log?: (msg: string) => void;
		error?: (msg: string) => void;
		packageDir?: string;
		npmPackage?: string;
		appName?: string;
	} = {},
): Promise<boolean> {
	if (args[0] !== "update") return false;

	const rest = args.slice(1).filter((a) => a !== "--self");
	if (rest.includes("-h") || rest.includes("--help")) {
		printUpdateHelp();
		process.exitCode = 0;
		return true;
	}
	if (rest.length > 0) {
		(deps.error ?? console.error)(`Unknown argument: ${rest[0]}`);
		printUpdateHelp();
		process.exitCode = 2;
		return true;
	}

	const npmPackage = deps.npmPackage ?? NPM_CLI_PACKAGE;
	const appName = deps.appName ?? APP_NAME;
	const published = deps.published ?? isPublishedInstall(PACKAGE_NAME, npmPackage);
	if (!published) {
		(deps.error ?? console.error)(
			`This tree is ${PACKAGE_NAME}, not a global ${NPM_CLI_PACKAGE} install. Use \`npm i -g ${NPM_CLI_PACKAGE}\` to update the published CLI; workspace \`npx ${APP_NAME}\` is not self-updated.`,
		);
		process.exitCode = 1;
		return true;
	}

	const log = deps.log ?? console.log;
	const error = deps.error ?? console.error;
	const check = deps.check ?? checkForUpdate;
	const result = await check({
		currentVersion: deps.currentVersion ?? VERSION,
		agentDir: getAgentDir(),
		published: true,
		packageName: npmPackage,
		appName,
		offline: process.env.PI_OFFLINE === "1",
		force: true,
	});
	if (!result) {
		error("Could not reach the npm registry to check for updates.");
		process.exitCode = 1;
		return true;
	}
	if (!result.newer) {
		log(`${appName} ${result.current} is up to date.`);
		process.exitCode = 0;
		return true;
	}

	const cwd = process.cwd();
	const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
	const npmArgv = settings.getNpmCommand() ?? ["npm"];
	const installArgv = [...npmArgv.slice(1), "install", "-g", `${npmPackage}@${result.latest}`];
	const command = npmArgv[0] ?? "npm";

	const packageDir = deps.packageDir ?? getPackageDir();
	(deps.warn ?? console.warn)(
		`Installing ${npmPackage}@${result.latest}. If this process is the global install (${packageDir}), Windows may fail to overwrite files until ${appName} exits.`,
	);

	const spawn =
		deps.spawn ??
		(async (cmd: string, argv: string[]) => {
			const child = spawnProcess(cmd, argv, { stdio: "inherit" });
			return waitForChildProcess(child);
		});

	const code = await spawn(command, installArgv);
	process.exitCode = code === 0 || code === null ? 0 : code;
	if ((process.exitCode ?? 0) === 0) {
		log(`Updated ${appName} ${result.current} → ${result.latest}.`);
	}
	return true;
}
