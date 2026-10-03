#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { npmNameFor } from "./lunr-npm-names.mjs";
import { release as computerRelease } from "./computer-use-packages.mjs";
import { spawnSync } from "node:child_process";

const packages = [
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into an
isolated directory outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Skip read-only source and lock checks before building
  --skip-test          Skip tests in a disposable home before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

export function parseArgs(args = process.argv.slice(2)) {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") {
			options.force = true;
			continue;
		}
		if (arg === "--skip-check") {
			options.skipCheck = true;
			continue;
		}
		if (arg === "--skip-test") {
			options.skipTest = true;
			continue;
		}
		if (arg === "--skip-install") {
			options.skipInstall = true;
			continue;
		}
		if (arg === "--skip-bun-install") {
			options.skipBunInstall = true;
			continue;
		}
		if (arg === "--out") {
			const value = args[++i];
			if (!value) {
				throw new Error("--out requires a directory");
			}
			options.outDir = value;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
	});

	if (result.status !== 0) {
		throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	}

	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (relativePath.split(sep)[0] !== ".." && !isAbsolute(relativePath));
}

// Resolve parent links even when the requested output does not exist yet.
function canonicalPath(path) {
	let ancestor = resolve(path);
	const suffix = [];
	while (true) {
		try {
			return resolve(realpathSync(ancestor), ...suffix);
		} catch (error) {
			if (error.code !== "ENOENT" || lstatSync(ancestor, { throwIfNoEntry: false })) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
}

export function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) {
		return mkdtempSync(join(tmpdir(), "lunr-local-release-"));
	}

	const outDir = resolve(options.outDir);

	const canonicalRepo = canonicalPath(repoRoot);
	const canonicalOut = canonicalPath(outDir);
	if (
		isInsidePath(outDir, resolve(repoRoot)) || isInsidePath(resolve(repoRoot), outDir) ||
		isInsidePath(canonicalOut, canonicalRepo) || isInsidePath(canonicalRepo, canonicalOut)
	) {
		throw new Error(`Output directory must be outside the repository and must not contain it: ${outDir}`);
	}

	if (existsSync(outDir)) {
		if (!options.force) {
			throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		}
		rmSync(outDir, { force: true, recursive: true });
	}

	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function fileSpecifier(fromDirectory, file) {
	const relativePath = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	if (!commandExists("bun")) {
		throw new Error("Bun is required for the local binary release build.");
	}
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	run("bash", [
		"scripts/build-binaries.sh",
		"--skip-install",
		"--skip-deps",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	]);
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = platform.startsWith("windows-") ? `lunr-${platform}.zip` : `lunr-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

function createLunrShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "lunr.cmd"))) {
			writeFileSync(join(installDirectory, "lunr.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\lunr.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "lunr.ps1"), '& "$PSScriptRoot/node_modules/.bin/lunr.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "lunr.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\lunr.exe" %*\r\n');
		writeFileSync(join(installDirectory, "lunr.ps1"), '& "$PSScriptRoot/node_modules/.bin/lunr.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "lunr"), join(installDirectory, "lunr"));
}

export function assertRepositoryRoot(repoRoot) {
	const manifest = readPackageJson(repoRoot);
	if (manifest.name !== "lunr" || manifest.private !== true || !existsSync(join(repoRoot, "scripts", "publish.mjs"))) {
		throw new Error("Run this script from the lunR repository root");
	}
	for (const pkg of packages) {
		if (readPackageJson(join(repoRoot, pkg.directory)).name !== pkg.name) {
			throw new Error(`Unexpected workspace package in ${pkg.directory}`);
		}
	}
}

// Keep the AI catalog unchanged; its regular package build regenerates it.
export function localBuildCommands() {
	return [
		["npm", ["--prefix", "packages/tui", "run", "build"]],
		["npm", ["exec", "--no", "--", "tsgo", "-p", "packages/ai/tsconfig.build.json"]],
		...["agent", "coding-agent", "orchestrator"].map((pkg) => ["npm", ["--prefix", `packages/${pkg}`, "run", "build"]]),
	];
}

export function localPackCommand(repoRoot, tarballDirectory) {
	// The publisher owns name rewriting, entrypoint checks, notices, payloads,
	// and npm's array/keyed-object pack output compatibility.
	return [process.execPath, [join(repoRoot, "scripts", "publish.mjs"), "--dry-run", "--pack-dir", tarballDirectory]];
}

export function localTarballs(repoRoot, tarballDirectory) {
	const version = readPackageJson(join(repoRoot, packages[0].directory)).version;
	const names = [
		...packages.map((pkg) => npmNameFor(pkg.name)),
		...computerRelease.artifacts.map((artifact) => artifact.packageName),
	];
	return new Map(
		names.map((name) => {
			const file = join(tarballDirectory, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
			if (!existsSync(file)) throw new Error(`Publisher did not create expected tarball: ${file}`);
			return [name, file];
		}),
	);
}

export function runIsolatedTests(repoRoot, execute = run) {
	const home = mkdtempSync(join(tmpdir(), "lunr-release-tests-"));
	const env = Object.fromEntries(
		[
			"PATH",
			"SystemRoot",
			"SYSTEMROOT",
			"WINDIR",
			"COMSPEC",
			"PATHEXT",
			"TERM",
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"TZ",
			"CI",
			"GITHUB_ACTIONS",
			"NO_COLOR",
			"FORCE_COLOR",
		].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
	);
	for (const [key, directory] of Object.entries({
		HOME: "home",
		USERPROFILE: "home",
		PI_CODING_AGENT_DIR: "agent",
		TMPDIR: "tmp",
		TMP: "tmp",
		TEMP: "tmp",
		XDG_CONFIG_HOME: "config",
		XDG_CACHE_HOME: "cache",
		XDG_DATA_HOME: "data",
		XDG_STATE_HOME: "state",
		XDG_RUNTIME_DIR: "runtime",
		APPDATA: "appdata",
		LOCALAPPDATA: "localappdata",
	})) {
		const path = join(home, directory);
		mkdirSync(path, { recursive: true, mode: 0o700 });
		env[key] = path;
	}
	env.PI_NO_LOCAL_LLM = "1";
	env.npm_config_update_notifier = "false";
	try {
		execute("bash", ["test.sh"], { cwd: repoRoot, env });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export function main(options = parseArgs(), repoRoot = process.cwd(), execute = run) {
	assertRepositoryRoot(repoRoot);
	const outDir = prepareOutputDirectory(options, repoRoot);
	const tarballDirectory = join(outDir, "tarballs");
	const nodeInstallDirectory = join(outDir, "node");
	const bunInstallDirectory = join(outDir, "bun-install");
	const binaryDirectory = join(outDir, "bun");
	mkdirSync(tarballDirectory, { recursive: true });

	if (!options.skipCheck) {
		execute("npm", ["exec", "--no", "--", "biome", "check", "packages/"], { cwd: repoRoot });
		for (const check of [
			"pinned-deps",
			"ts-imports",
			"shrinkwrap",
			"install-lock:coding-agent",
			"no-npm-publish-workflow",
			"browser-smoke",
		])
			execute("npm", ["run", `check:${check}`], { cwd: repoRoot });
	}

	if (!options.skipTest) {
		runIsolatedTests(repoRoot, execute);
	}

	for (const [command, args] of localBuildCommands()) execute(command, args, { cwd: repoRoot });
	const [packCommand, packArgs] = localPackCommand(repoRoot, tarballDirectory);
	execute(packCommand, packArgs, { cwd: repoRoot });
	const tarballs = localTarballs(repoRoot, tarballDirectory);
	const publicTarballs = [...tarballs].filter(
		([name]) =>
			!computerRelease.artifacts.some((artifact) => artifact.packageName === name) ||
			computerRelease.artifacts.some(
				(artifact) =>
					artifact.packageName === name && artifact.platform === process.platform && artifact.arch === process.arch,
			),
	);

	let binaryPlatform;
	if (!options.skipInstall) {
		binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);

		mkdirSync(nodeInstallDirectory, { recursive: true });
		const dependencies = Object.fromEntries(
			publicTarballs.map(([name, file]) => [name, fileSpecifier(nodeInstallDirectory, file)]),
		);
		const installPackageJson = `${JSON.stringify({ private: true, dependencies, overrides: Object.fromEntries([...tarballs].map(([name, file]) => [name, fileSpecifier(nodeInstallDirectory, file)])) }, undefined, "\t")}\n`;
		writeFileSync(join(nodeInstallDirectory, "package.json"), installPackageJson);

		execute("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: nodeInstallDirectory });
		createLunrShim(nodeInstallDirectory);

		if (!options.skipBunInstall) {
			if (!commandExists("bun")) {
				throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
			}
			mkdirSync(bunInstallDirectory, { recursive: true });
			const bunDependencies = Object.fromEntries(
				publicTarballs.map(([name, file]) => [name, fileSpecifier(bunInstallDirectory, file)]),
			);
			writeFileSync(
				join(bunInstallDirectory, "package.json"),
				`${JSON.stringify({ private: true, dependencies: bunDependencies, overrides: Object.fromEntries([...tarballs].map(([name, file]) => [name, fileSpecifier(bunInstallDirectory, file)])) }, undefined, "\t")}\n`,
			);
			execute("bun", ["install", "--production", "--ignore-scripts"], { cwd: bunInstallDirectory });
			createLunrShim(bunInstallDirectory);
		}
	}

	console.log("\nLocal release artifacts created:");
	console.log(`  ${outDir}`);
	console.log("\nTarballs:");
	for (const tarball of tarballs.values()) {
		console.log(`  ${tarball}`);
	}

	if (!options.skipInstall) {
		console.log("\nLocal Bun binary release:");
		console.log(`  ${binaryDirectory}`);
		console.log(
			`  ${join(outDir, `lunr-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`,
		);
		console.log("\nRun the local Bun binary release from outside the repository:");
		console.log(
			`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "lunr.exe" : "lunr")} --help`,
		);

		console.log("\nIsolated npm install:");
		console.log(`  ${nodeInstallDirectory}`);
		console.log("\nRun the locally packed npm CLI from outside the repository:");
		console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "lunr.cmd" : "lunr")} --help`);

		if (!options.skipBunInstall) {
			console.log("\nIsolated Bun package install:");
			console.log(`  ${bunInstallDirectory}`);
			console.log("\nRun the locally packed Bun package CLI from outside the repository:");
			console.log(`  ${join(bunInstallDirectory, process.platform === "win32" ? "lunr.cmd" : "lunr")} --help`);
		}
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
