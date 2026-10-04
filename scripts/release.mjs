#!/usr/bin/env node
/** Prepare reviewable release changes on a branch. Publication is a separate explicit action. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRepositoryRoot, runIsolatedTests } from "./local-release.mjs";

const bumpTypes = new Set(["major", "minor", "patch"]);
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const publicPackages = ["ai", "tui", "agent", "coding-agent"];
export const publicationNotice = "Pushing a v* tag triggers npm publication and the GitHub Release workflows.";

export function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: options.capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
	return result.stdout ?? "";
}

export function versionCommands(target) {
	if (!bumpTypes.has(target) && !semver.test(target)) throw new Error("Expected major, minor, patch, or x.y.z.");
	return [
		["npm", ["version", target, "--workspaces", "--no-git-tag-version"]],
		[process.execPath, ["scripts/sync-versions.js"]],
		["npm", ["install", "--package-lock-only", "--ignore-scripts"]],
	];
}

function version(root) {
	return JSON.parse(readFileSync(join(root, "packages/ai/package.json"), "utf8")).version;
}

export function prepareRelease(target, { root = process.cwd(), execute = run, test = runIsolatedTests } = {}) {
	assertRepositoryRoot(root);
	const commands = versionCommands(target);
	const invoke = (command, args, capture = false) => execute(command, args, { cwd: root, capture });
	const branch = invoke("git", ["branch", "--show-current"], true).trim();
	if (!branch || branch === "master" || branch === "main")
		throw new Error("Prepare a release on a release branch, then open a PR to master.");
	if (invoke("git", ["status", "--porcelain"], true).trim())
		throw new Error("Commit or stash changes before preparing a release.");
	if (semver.test(target)) {
		const current = version(root).split(".").map(Number);
		const next = target.split(".").map(Number);
		const firstDifference = next.findIndex((part, index) => part !== current[index]);
		if (firstDifference === -1 || next[firstDifference] < current[firstDifference])
			throw new Error("Release version must increase.");
	}
	for (const [command, args] of commands) invoke(command, args);
	const releaseVersion = version(root);
	const date = new Date().toISOString().slice(0, 10);
	for (const pkg of readdirSync(join(root, "packages"))) {
		const path = join(root, "packages", pkg, "CHANGELOG.md");
		if (!existsSync(path)) continue;
		const source = readFileSync(path, "utf8");
		if (!source.includes("## [Unreleased]")) continue;
		writeFileSync(path, source.replace("## [Unreleased]", `## [Unreleased]\n\n## [${releaseVersion}] - ${date}`));
	}
	for (const script of ["shrinkwrap:coding-agent", "install-lock:coding-agent"]) invoke("npm", ["run", script]);
	// Checks must not format unrelated files while preparing the release.
	invoke("npm", ["exec", "--no", "--", "biome", "check", "packages/"]);
	for (const check of [
		"pinned-deps",
		"ts-imports",
		"shrinkwrap",
		"install-lock:coding-agent",
		"no-npm-publish-workflow",
		"browser-smoke",
	])
		invoke("npm", ["run", `check:${check}`]);
	test(root);
	console.log(
		`Prepared v${releaseVersion} on ${branch}. Review the changes, commit, and open a PR to master. No commit, tag, or push was made.`,
	);
	return releaseVersion;
}

/** Tag only a merged commit supplied explicitly by the release operator. */
export function publishTag(releaseVersion, commit, { root = process.cwd(), execute = run } = {}) {
	assertRepositoryRoot(root);
	if (!semver.test(releaseVersion) || !/^[0-9a-f]{40}$/.test(commit ?? ""))
		throw new Error("Expected x.y.z and a full merged commit SHA.");
	const invoke = (command, args, capture = false) => execute(command, args, { cwd: root, capture });
	if (invoke("git", ["status", "--porcelain"], true).trim())
		throw new Error("Commit or stash changes before tagging a release.");
	invoke("git", ["fetch", "origin", "master"]);
	invoke("git", ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
	for (const pkg of publicPackages) {
		const manifest = JSON.parse(invoke("git", ["show", `${commit}:packages/${pkg}/package.json`], true));
		if (manifest.version !== releaseVersion) throw new Error(`Merged ${pkg} version does not match ${releaseVersion}.`);
	}
	const tag = `v${releaseVersion}`;
	if (
		invoke("git", ["tag", "--list", tag], true).trim() ||
		invoke("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true).trim()
	)
		throw new Error(`${tag} already exists.`);
	console.log(publicationNotice);
	invoke("git", ["tag", "-a", tag, commit, "-m", `Release ${tag}`]);
	invoke("git", ["push", "origin", `refs/tags/${tag}`]);
	console.log(
		`Pushed ${tag} at ${commit}. Publication workflows have been triggered; successful publication still requires workflow and registry verification.`,
	);
}

export function main(args = process.argv.slice(2)) {
	if (args[0] === "publish-tag" && args.length === 3) return publishTag(args[1], args[2]);
	if (args.length === 1) return prepareRelease(args[0]);
	throw new Error(
		"Usage: node scripts/release.mjs <major|minor|patch|x.y.z>\n       node scripts/release.mjs publish-tag <x.y.z> <merged-commit-sha>\nPreparation only changes branch files. publish-tag triggers npm and GitHub Release publication.",
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
