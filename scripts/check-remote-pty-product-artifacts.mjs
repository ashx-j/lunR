#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublishedEntryPointsExist, rewritePackageJsonForNpm } from "./lunr-npm-names.mjs";
import { copyPackageForPublish } from "./lunr-npm-staging.mjs";
import { assertStagedTarball } from "./remote-product-tarballs.mjs";
import { candidateVersion, installCandidate, isolatedNpmEnvironment, npmCliPath } from "./remote-pty-probe-install.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = process.argv.find((arg) => arg.startsWith("--scope="))?.slice(8) ?? "full";
const bunPath = process.argv.find((arg) => arg.startsWith("--bun-path="))?.slice(11);
if (process.argv.slice(2).some((arg) => !arg.startsWith("--scope=") && !arg.startsWith("--bun-path="))) throw new Error("Expected --scope=npm|standalone|full and optional --bun-path=...");
assert.ok(["npm", "standalone", "full"].includes(scope));
const target = `${process.platform}-${process.arch}`;
assert.ok(["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"].includes(target));
const directory = realpathSync(mkdtempSync(join(tmpdir(), "lunr-phase0-product-")));
const report = { scope, target, node: process.version, npm: "not-run", standalone: "not-run", result: "not-run" };

function npmFailureDetails(profile) {
	const logsDir = join(profile, "cache", "_logs");
	if (!existsSync(logsDir)) return "npm timing log unavailable";
	const logName = readdirSync(logsDir).filter((name) => name.endsWith("-debug-0.log")).sort().at(-1);
	if (!logName) return "npm timing log unavailable";
	const lines = readFileSync(join(logsDir, logName), "utf8").split(/\r?\n/)
		.filter((line) => /^\d+ (?:http fetch|timing |error |warn )/.test(line)).slice(-20)
		.map((line) => line.slice(0, 300));
	return `npm log ${logName}:\n${lines.join("\n") || "no fetch, timing or error entries"}`;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: options.cwd ?? directory, env: options.env ?? process.env, encoding: "utf8", timeout: options.timeout ?? 180_000, maxBuffer: 5 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? ""}\n${result.stdout?.slice(-1600)}\n${result.stderr?.slice(-1600)}${options.npmProfile ? `\n${npmFailureDetails(options.npmProfile)}` : ""}`);
	return result.stdout.trim();
}

async function npmEnv(profile) {
	return { ...await isolatedNpmEnvironment(profile), npm_config_cache: join(profile, "cache"), npm_config_timing: "true", PI_OFFLINE: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };
}

function assertCandidateFromArtifact(anchor, artifactRoot) {
	const require = createRequire(join(anchor, "package.json"));
	for (const name of ["@lydell/node-pty", `@lydell/node-pty-${target}`]) {
		const path = require.resolve(name);
		assert.ok(path.startsWith(`${join(artifactRoot, "node_modules", "@lydell")}${sep}`), `${name} escaped artifact: ${path}`);
	}
	const wrapper = JSON.parse(readFileSync(join(artifactRoot, "node_modules", "@lydell", "node-pty", "package.json"), "utf8"));
	const native = JSON.parse(readFileSync(join(artifactRoot, "node_modules", "@lydell", `node-pty-${target}`, "package.json"), "utf8"));
	assert.equal(wrapper.version, candidateVersion);
	assert.equal(wrapper.optionalDependencies[`@lydell/node-pty-${target}`], candidateVersion);
	assert.equal(native.version, candidateVersion);
	for (const pkg of [wrapper, native]) for (const hook of ["preinstall", "install", "postinstall"]) assert.equal(pkg.scripts?.[hook], undefined);
	return require.resolve("@lydell/node-pty");
}

async function probeTui(artifactRoot, cli, anchor, standalone, controllerInstall = artifactRoot) {
	const home = join(directory, standalone ? "standalone-home" : "npm-home");
	const workspace = join(directory, standalone ? "standalone-workspace" : "npm-workspace");
	const temp = join(directory, standalone ? "standalone-tmp" : "npm-tmp");
	const agentDir = join(home, ".lunr", "agent");
	for (const path of [agentDir, workspace, temp]) await mkdir(path, { recursive: true });
	const probe = join(root, "scripts", "remote-pty-tui-probe.cjs");
	const extension = join(anchor, standalone ? "phase0-product-extension.mjs" : "dist/phase0-product-extension.mjs");
	const env = { ...process.env, PI_REMOTE_PHASE0_NATIVE_EXTENSION: extension, PI_REMOTE_PHASE0_ARTIFACT_ROOT: artifactRoot, PI_REMOTE_PHASE0_STANDALONE_CLI: standalone ? "1" : "0", PI_REMOTE_PHASE0_DIAGNOSTIC_FILE: join(temp, "native-diagnostic.txt") };
	const output = run(process.execPath, [probe, controllerInstall, cli, workspace, home, agentDir, temp], { cwd: workspace, env, timeout: standalone ? 120_000 : 45_000 });
	const result = JSON.parse(output);
	assert.equal(result.result, "passed");
	const expectedBackend = standalone ? "bun-terminal" : "native-addon";
	assert.equal(result.artifactPtyBackend, expectedBackend);
	assert.equal(result.artifactNativeSpawn, expectedBackend === "native-addon");
	if (expectedBackend === "bun-terminal") assert.ok(["pending", "0", "1"].includes(result.artifactPtyStreamStatus));
	else assert.equal(result.artifactPtyStreamStatus, "not-applicable");
	if (standalone) {
		assert.equal(result.compiledWorker.ownerBackend, expectedBackend);
		assert.ok(result.compiledWorker.pid > 0);
		assert.equal(result.compiledWorker.executable, process.platform === "win32" ? "lunr.exe" : "lunr");
		assert.equal(result.compiledWorker.firstPaint, true);
		assert.equal(result.compiledWorker.settings, true);
		assert.equal(result.compiledWorker.input, true);
		assert.equal(result.compiledWorker.detachedReattachColumns, 110);
		assert.equal(result.compiledWorker.aliveAfterDetach, true);
	} else assert.equal(result.compiledWorker, "not-run");
	return { firstPaint: result.tuiFirstPaint, settings: result.settingsDialogSeen, artifactPtyBackend: result.artifactPtyBackend, artifactPtyStreamStatus: result.artifactPtyStreamStatus, compiledWorker: result.compiledWorker, artifactNativeSpawn: result.artifactNativeSpawn, reattachColumns: result.repaintColumns };
}

async function proveNpm() {
	const packageDirs = ["packages/ai", "packages/tui", "packages/agent", "packages/coding-agent"];
	const packs = join(directory, "packs");
	await mkdir(packs);
	const dependencies = {};
	const stagedArchives = new Map();
	for (const relative of packageDirs) {
		const staged = copyPackageForPublish(join(root, relative), directory);
		const manifestPath = join(staged.dest, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (relative === "packages/coding-agent") {
			manifest.optionalDependencies["@lydell/node-pty"] = candidateVersion;
			cpSync(join(root, "scripts", "remote-pty-product-extension.mjs"), join(staged.dest, "dist", "phase0-product-extension.mjs"));
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		}
		assertPublishedEntryPointsExist(staged.dest, manifest, staged.publishedName);
		const stagePacks = join(packs, relative.split("/").at(-1));
		await mkdir(stagePacks);
		run(process.execPath, [npmCliPath(), "pack", "--ignore-scripts", "--pack-destination", stagePacks], { cwd: staged.dest, env: await npmEnv(join(directory, "pack-profile")) });
		const filenames = readdirSync(stagePacks).filter((name) => name.endsWith(".tgz"));
		assert.equal(filenames.length, 1);
		const archive = join(stagePacks, filenames[0]);
		dependencies[staged.publishedName] = `file:${archive}`;
		stagedArchives.set(staged.publishedName, archive);
	}
	const install = join(directory, "product-npm-install");
	await mkdir(install);
	writeFileSync(join(install, "package.json"), `${JSON.stringify({ name: "phase0-isolated-product", private: true, version: "1.0.0", dependencies })}\n`);
	const installProfile = join(directory, "install-profile");
	// Windows CI was still unpacking packages after five minutes; keep this budget local to the product install.
	const installTimeout = process.platform === "win32" ? 600_000 : 360_000;
	run(process.execPath, [npmCliPath(), "install", "--no-audit", "--no-fund", "--foreground-scripts"], { cwd: install, env: await npmEnv(installProfile), timeout: installTimeout, npmProfile: installProfile });
	const lock = JSON.parse(readFileSync(join(install, "package-lock.json"), "utf8"));
	for (const [name, archive] of stagedArchives) assertStagedTarball(lock, name, archive, install);
	const productRoot = join(install, "node_modules", "@ashx-j", "lunr");
	assert.equal(lstatSync(productRoot).isSymbolicLink(), false, "npm product links to workspace");
	const manifest = JSON.parse(readFileSync(join(productRoot, "package.json"), "utf8"));
	assert.equal(manifest.optionalDependencies["@lydell/node-pty"], candidateVersion);
	for (const name of Object.keys(dependencies)) {
		const path = join(install, "node_modules", ...name.split("/"));
		assert.equal(lstatSync(path).isSymbolicLink(), false, `${name} links outside isolated install`);
		assert.equal(JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name, name);
	}
	const wrapperPath = assertCandidateFromArtifact(productRoot, install);
	const productRequire = createRequire(join(productRoot, "package.json"));
	const playwrightRequire = createRequire(productRequire.resolve("playwright-core/package.json"));
	assert.equal(typeof playwrightRequire("chromium-bidi/lib/cjs/bidiMapper/BidiMapper").BidiServer.createAndStart, "function");
	assert.equal(typeof playwrightRequire("chromium-bidi/lib/cjs/cdp/CdpConnection").MapperCdpConnection, "function");
	const native = JSON.parse(run(process.execPath, [join(root, "scripts", "remote-pty-runtime-probe.cjs"), productRoot, directory]));
	assert.equal(native.result, "passed");
	const tui = await probeTui(install, join(productRoot, "dist", "cli.js"), productRoot, false);
	report.npm = { result: "passed", tarballs: Object.keys(dependencies), candidateVersion, wrapperPath, browserBidiModules: true, scriptsEnabled: true, candidateCompilerFallback: false, native, tui };
	return { install, productRoot };
}

async function proveStandalone() {
	const found = bunPath ?? (process.platform === "win32" ? spawnSync("where.exe", ["bun.exe"], { encoding: "utf8" }).stdout?.split(/\r?\n/)[0] : spawnSync("which", ["bun"], { encoding: "utf8" }).stdout?.trim());
	if (!found) {
		report.standalone = "blocked: Bun executable required; pass --bun-path=<isolated Bun>";
		return;
	}
	const bun = resolve(found);
	assert.ok(existsSync(bun), `Bun executable missing: ${bun}`);
	assert.equal(run(bun, ["--version"]), "1.4.2", "Standalone compiler must match the Bun Terminal runtime under test");
	const nativeInstall = join(directory, "standalone-native");
	await installCandidate(nativeInstall, join(directory, "native-profile"));
	const output = join(directory, "standalone-layout");
	const bash = process.platform === "win32" ? "bash" : "/bin/bash";
	const shellPath = (path) => process.platform === "win32" ? run("cygpath", ["-u", path]) : path;
	run(bash, [join(root, "scripts", "build-binaries.sh"), "--skip-install", "--skip-deps", "--skip-build", "--skip-archive", "--platform", target.replace("win32-", "windows-"), "--bun-bin", shellPath(bun), "--out", shellPath(output)], { cwd: root, timeout: 240_000 });
	const artifact = join(output, target.replace("win32-", "windows-"));
	cpSync(join(root, "scripts", "remote-pty-product-extension.mjs"), join(artifact, "phase0-product-extension.mjs"));
	const source = JSON.parse(readFileSync(join(root, "packages", "coding-agent", "package.json"), "utf8"));
	const manifest = rewritePackageJsonForNpm(source);
	writeFileSync(join(artifact, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	const cli = join(artifact, process.platform === "win32" ? "lunr.exe" : "lunr");
	assert.ok(existsSync(cli), "Compiled product executable missing");
	const nativeAddonPresent = existsSync(join(artifact, "node_modules", "@lydell", "node-pty"));
	assert.equal(nativeAddonPresent, false);
	assert.equal(manifest.optionalDependencies["@lydell/node-pty"], undefined);
	const ptyBackend = "bun-terminal";
	report.standalone = { result: "blocked", compiledCli: true, wrapperPath: "not-packaged", candidateVersion: "not-used", nativeBundle: "none", nativeAddonPresent, ptyBackend, artifactPtyTui: "not-run" };
	const tui = await probeTui(artifact, cli, artifact, true, nativeInstall);
	report.standalone = { result: "passed", compiledCli: true, wrapperPath: "not-packaged", candidateVersion: "not-used", nativeBundle: "none", nativeAddonPresent, ptyBackend, tui };
}

try {
	if (scope !== "standalone") await proveNpm();
	if (scope !== "npm") await proveStandalone();
	report.result = report.npm === "not-run" || report.npm.result === "passed" ? (report.standalone === "not-run" || report.standalone.result === "passed" ? "passed" : "blocked") : "failed";
	if (report.standalone !== "not-run" && report.standalone.result !== "passed") process.exitCode = 2;
} catch (error) {
	report.result = "failed";
	report.failure = String(error.stack ?? error);
	process.exitCode = 1;
} finally {
	for (let attempt = 0; attempt < 10; attempt++) {
		try { rmSync(directory, { recursive: true, force: true }); break; }
		catch (error) { if (attempt === 9) { report.cleanupFailure = String(error); process.exitCode = 1; } else await new Promise((resolve) => setTimeout(resolve, 500)); }
	}
	console.log(JSON.stringify(report));
}
