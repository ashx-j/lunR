#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertNoEarendil, npmNameFor, rewritePackageJsonForNpm, rewriteWorkspaceSpecifiers } from "./lunr-npm-names.mjs";

const packages = [
	{ directory: "packages/ai", workspaceName: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", workspaceName: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", workspaceName: "@earendil-works/pi-agent-core" },
	{ directory: "packages/coding-agent", workspaceName: "@earendil-works/pi-coding-agent" },
];
const rewriteExtensions = new Set([".js", ".mjs", ".cjs", ".d.ts", ".ts", ".map", ".json"]);

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and stages the public @ashx-j/lunr packages, packs them, then installs
those tarballs into isolated directories outside the repository.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh before building
  --skip-install       Only create tarballs; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = { force: false, outDir: undefined, skipBunInstall: false, skipCheck: false, skipInstall: false, skipTest: false };
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") options.force = true;
		else if (arg === "--skip-check") options.skipCheck = true;
		else if (arg === "--skip-test") options.skipTest = true;
		else if (arg === "--skip-install") options.skipInstall = true;
		else if (arg === "--skip-bun-install") options.skipBunInstall = true;
		else if (arg === "--out") {
			const value = args[++i];
			if (!value) throw new Error("--out requires a directory");
			options.outDir = value;
		} else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function commandForPlatform(command) {
	return process.platform === "win32" && (command === "npm" || command === "npx") ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${[command, ...args].join(" ")}${output ? `\n${output}` : ""}`);
	}
	return result.stdout ?? "";
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function commandExists(command) {
	return spawnSync(commandForPlatform(command), ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
}

function isInsidePath(child, parent) {
	const relativePath = relative(parent, child);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function prepareOutputDirectory(options, repoRoot) {
	if (!options.outDir) return mkdtempSync(join(tmpdir(), "lunr-local-release-"));
	const outDir = resolve(options.outDir);
	if (isInsidePath(outDir, repoRoot)) throw new Error(`Output directory must be outside the repository: ${outDir}`);
	if (existsSync(outDir)) {
		if (!options.force) throw new Error(`Output directory already exists. Use --force to replace it: ${outDir}`);
		rmSync(outDir, { force: true, recursive: true });
	}
	mkdirSync(outDir, { recursive: true });
	return outDir;
}

function shouldRewrite(filePath) {
	const normalized = filePath.replaceAll("\\", "/");
	if (normalized.includes("/node_modules/")) return false;
	return [...rewriteExtensions].some((extension) => normalized.endsWith(extension));
}

function rewriteTree(root) {
	const stack = [root];
	while (stack.length > 0) {
		const directory = stack.pop();
		for (const name of readdirSync(directory)) {
			const file = join(directory, name);
			if (statSync(file).isDirectory()) {
				if (name !== "node_modules") stack.push(file);
				continue;
			}
			if (!shouldRewrite(file)) continue;
			const before = readFileSync(file, "utf8");
			const after = rewriteWorkspaceSpecifiers(before);
			if (after !== before) writeFileSync(file, after, "utf8");
		}
	}
}

function stagePackage(pkg, stagingRoot) {
	const sourcePackage = readPackageJson(pkg.directory);
	if (sourcePackage.name !== pkg.workspaceName) {
		throw new Error(`${pkg.directory}/package.json has name ${sourcePackage.name}, expected ${pkg.workspaceName}`);
	}
	const publicName = npmNameFor(pkg.workspaceName);
	if (!publicName) throw new Error(`Missing public package mapping for ${pkg.workspaceName}`);
	const stageDirectory = join(stagingRoot, publicName.slice("@ashx-j/".length));
	cpSync(pkg.directory, stageDirectory, {
		recursive: true,
		filter: (source) => {
			const normalized = source.replaceAll("\\", "/");
			return !normalized.includes("/node_modules") && !normalized.includes("/binaries") && !normalized.endsWith("npm-shrinkwrap.json");
		},
	});
	const stagedPackage = rewritePackageJsonForNpm(sourcePackage);
	writeFileSync(join(stageDirectory, "package.json"), `${JSON.stringify(stagedPackage, null, "\t")}\n`);
	rewriteTree(stageDirectory);
	assertNoEarendil(readFileSync(join(stageDirectory, "package.json"), "utf8"), `${publicName} package.json`);
	const mainFile = join(stageDirectory, "dist", "main.js");
	if (existsSync(mainFile)) assertNoEarendil(readFileSync(mainFile, "utf8"), `${publicName} dist/main.js`);
	return { directory: stageDirectory, name: publicName, version: stagedPackage.version };
}

function packPackage(pkg, tarballDirectory) {
	const output = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	const packed = JSON.parse(output)[0];
	return join(tarballDirectory, packed.filename);
}

function buildPackages(repoRoot) {
	for (const directory of ["tui", "ai", "agent"]) {
		run("npx", ["tsgo", "-p", `packages/${directory}/tsconfig.build.json`], { cwd: repoRoot });
	}
	run("npm", ["--prefix", "packages/coding-agent", "run", "build"], { cwd: repoRoot });
	run("npm", ["--prefix", "packages/orchestrator", "run", "build"], { cwd: repoRoot });
	run("git", ["diff", "--exit-code", "--", "packages/ai"], { cwd: repoRoot });
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
	if (!commandExists("bun")) throw new Error("Bun is required for the local binary release build.");
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	run("./scripts/build-binaries.sh", ["--skip-install", "--skip-deps", "--skip-build", "--platform", platform, "--out", binaryBuildDirectory]);
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = platform.startsWith("windows-") ? `lunr-${platform}.zip` : `lunr-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

function createLunrShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		writeFileSync(join(installDirectory, "lunr.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\lunr.cmd" %*\r\n');
		writeFileSync(join(installDirectory, "lunr.ps1"), '& "$PSScriptRoot/node_modules/.bin/lunr.ps1" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "lunr"), join(installDirectory, "lunr"));
}

function smokeInstall(installDirectory) {
	const shim = join(installDirectory, process.platform === "win32" ? "lunr.cmd" : "lunr");
	run(shim, ["--version"], { cwd: installDirectory });
	run("node", ["--input-type=module", "--eval", "await import('@ashx-j/lunr'); await import('@ashx-j/lunr-ai');"], { cwd: installDirectory });
}

const options = parseArgs();
const repoRoot = process.cwd();
if (readPackageJson(repoRoot).name !== "lunr") throw new Error("Run this script from the lunR repository root");

const outDir = prepareOutputDirectory(options, repoRoot);
const tarballDirectory = join(outDir, "tarballs");
const stagingDirectory = join(outDir, "staging");
const nodeInstallDirectory = join(outDir, "node");
const bunInstallDirectory = join(outDir, "bun-install");
const binaryDirectory = join(outDir, "bun");
mkdirSync(tarballDirectory, { recursive: true });
mkdirSync(stagingDirectory, { recursive: true });

if (!options.skipCheck) run("npm", ["run", "check"], { cwd: repoRoot });
if (!options.skipTest) run("./test.sh", [], { cwd: repoRoot });
buildPackages(repoRoot);

const stagedPackages = packages.map((pkg) => stagePackage(pkg, stagingDirectory));
const versions = new Set(stagedPackages.map((pkg) => pkg.version));
if (versions.size !== 1) throw new Error(`Release packages are not lockstep versioned: ${[...versions].join(", ")}`);
const tarballs = new Map(stagedPackages.map((pkg) => [pkg.name, packPackage(pkg, tarballDirectory)]));

let binaryPlatform;
if (!options.skipInstall) {
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);
	mkdirSync(nodeInstallDirectory, { recursive: true });
	const dependencies = Object.fromEntries([...tarballs].map(([name, file]) => [name, fileSpecifier(nodeInstallDirectory, file)]));
	writeFileSync(join(nodeInstallDirectory, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }, null, "\t")}\n`);
	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: nodeInstallDirectory });
	createLunrShim(nodeInstallDirectory);
	smokeInstall(nodeInstallDirectory);

	if (!options.skipBunInstall) {
		if (!commandExists("bun")) throw new Error("Bun is required for the isolated Bun install. Use --skip-bun-install to skip it.");
		mkdirSync(bunInstallDirectory, { recursive: true });
		const bunDependencies = Object.fromEntries([...tarballs].map(([name, file]) => [name, fileSpecifier(bunInstallDirectory, file)]));
		writeFileSync(join(bunInstallDirectory, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies: bunDependencies, overrides: bunDependencies }, null, "\t")}\n`);
		run("bun", ["install", "--production", "--ignore-scripts"], { cwd: bunInstallDirectory });
		createLunrShim(bunInstallDirectory);
		smokeInstall(bunInstallDirectory);
	}
}

console.log("\nLocal release artifacts created:");
console.log(`  ${outDir}`);
console.log("\nPublic tarballs:");
for (const [name, tarball] of tarballs) console.log(`  ${name}: ${tarball}`);
if (!options.skipInstall) {
	const extension = String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz";
	console.log(`\nBinary archive: ${join(outDir, `lunr-${binaryPlatform}.${extension}`)}`);
	console.log(`Isolated npm install: ${nodeInstallDirectory}`);
	if (!options.skipBunInstall) console.log(`Isolated Bun install: ${bunInstallDirectory}`);
}
