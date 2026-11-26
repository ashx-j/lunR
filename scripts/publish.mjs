#!/usr/bin/env node
/**
 * Publish lunR packages to the public npm registry under @ashx-j/*.
 * Source package.json names stay @earendil-works/pi-* (workspace).
 * This script copies each package to a temp dir, rewrites names, and
 * publishes that copy. It refuses if any @earendil-works/* name would ship.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	assertPublishedEntryPointsExist,
	assertPublishedTreeHasNoEarendil,
	DEV_WORKSPACE_TO_NPM,
	NPM_DEV_CLI_PACKAGE,
	publishTagFor,
	WORKSPACE_TO_NPM,
	rewritePackageJsonForNpm,
	rewritePackageLockForNpm,
	rewriteWorkspaceSpecifiers,
} from "./lunr-npm-names.mjs";

import { addPayloadDependencies, release as computerRelease, stagePayloadPackages } from "./computer-use-packages.mjs";
import { stagePackageNotice } from "./distribution-assets.mjs";
import { QUALIFY_STATUS_CONTEXT, qualifyStatus } from "./qualify-release.mjs";

const REWRITE_EXT = new Set([".js", ".mjs", ".cjs", ".d.ts", ".ts", ".map", ".json"]);

function shouldRewriteFile(filePath) {
	const norm = filePath.replaceAll("\\", "/");
	if (norm.includes("/node_modules/")) return false;
	for (const ext of REWRITE_EXT) {
		if (norm.endsWith(ext)) return true;
	}
	return false;
}

function rewritePublishedTree(root) {
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === "node_modules") continue;
				stack.push(full);
				continue;
			}
			if (!shouldRewriteFile(full)) continue;
			const before = readFileSync(full, "utf8");
			const after = rewriteWorkspaceSpecifiers(before, packageNames);
			if (after !== before) writeFileSync(full, after, "utf8");
		}
	}
}

const packages = [
	{ directory: "packages/ai", workspaceName: "@earendil-works/pi-ai" },
	{ directory: "packages/tui", workspaceName: "@earendil-works/pi-tui" },
	{ directory: "packages/agent", workspaceName: "@earendil-works/pi-agent-core" },
	{ directory: "packages/coding-agent", workspaceName: "@earendil-works/pi-coding-agent" },
];

const { values: options } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		// --require-qualify refuses to publish unless HEAD has a passing `npm run qualify` commit status
		// (scripts/qualify-release.mjs). Off by default; the stable workflow passes it when the owner turns the gate on.
		"require-qualify": { type: "boolean", default: false },
		"pack-dir": { type: "string" },
		// --manifest <file> records each package's name, version and packed integrity for scripts/verify-npm-release.mjs.
		manifest: { type: "string" },
		channel: { type: "string", default: "stable" },
		version: { type: "string" },
	},
});
const dryRun = options["dry-run"];
const requireQualify = options["require-qualify"];
const packDirectory = options["pack-dir"];
const manifestPath = options.manifest;
if (packDirectory && (!dryRun || !existsSync(packDirectory) || !statSync(packDirectory).isDirectory())) {
	throw new Error("--pack-dir requires --dry-run and an existing destination directory.");
}
if (options.channel !== "stable" && options.channel !== "dev") throw new Error("--channel must be stable or dev");
if (options.channel === "stable" && options.version) throw new Error("Stable publication reads package versions; omit --version");
if (options.channel === "dev" && !/^\d+\.\d+\.\d+-dev\.\d+\.\d+$/.test(options.version ?? "")) {
	throw new Error("Dev publication requires --version <base>-dev.<run>.<attempt>");
}
const packageNames = options.channel === "dev" ? DEV_WORKSPACE_TO_NPM : WORKSPACE_TO_NPM;
const rewriteOptions = { packageNames, version: options.version };

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
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
		throw new Error(
			output
				? `Command failed: ${command} ${args.join(" ")}\n${output}`
				: `Command failed: ${command} ${args.join(" ")}`,
		);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run the package build before publishing.`);
	}
	assertPublishedEntryPointsExist(directory, readPackageJson(directory), directory);
}

async function isPublished(name, version) {
	const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}?cache=${Date.now()}`;
	const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
	if (res.status === 404) return false;
	if (!res.ok) {
		throw new Error(`Failed to query ${name}@${version}: HTTP ${res.status}`);
	}
	return true;
}

async function waitForPublished(name, version) {
	for (let attempt = 0; attempt < 180; attempt++) {
		if (await isPublished(name, version)) return;
		await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	throw new Error(`${name}@${version} is not visible on npm after publication`);
}

function copyPackageForPublish(directory) {
	const dest = mkdtempSync(join(tmpdir(), "lunr-publish-"));
	cpSync(directory, dest, {
		recursive: true,
		filter: (src) => {
			const norm = src.replaceAll("\\", "/");
			if (norm.includes("/node_modules")) return false;
			if (norm.includes("/binaries")) return false;
			if (norm.includes("/native/computer-use/") && /\.(zip|tar\.gz|json)$/.test(norm)) return false;
			return true;
		},
	});
	stagePackageNotice(dest);
	const sourcePkg = readPackageJson(directory);
	const rewritten = rewritePackageJsonForNpm(sourcePkg, rewriteOptions);
	if (rewritten.name === NPM_DEV_CLI_PACKAGE) cpSync("scripts/lunr-dev-readme.md", join(dest, "README.md"));
	if (rewritten.repository && rewritten.repository.directory === undefined) {
		delete rewritten.repository.directory;
	}
	writeFileSync(join(dest, "package.json"), `${JSON.stringify(rewritten, null, "\t")}\n`, "utf8");
	rewritePublishedTree(dest);
	if (sourcePkg.name === "@earendil-works/pi-coding-agent") {
		const shrinkwrapPath = join(dest, "npm-shrinkwrap.json");
		const shrinkwrap = rewritePackageLockForNpm(JSON.parse(readFileSync(shrinkwrapPath, "utf8")), rewriteOptions);
		// The payload packages stay out of the shrinkwrap: npm does not check os/cpu for a dependency's
		// shrinkwrap, so every platform's payload would install. lunR downloads the host's on first use.
		writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, "\t")}\n`);
		const installerPath = join(dest, "install-lock", "package-lock.json");
		const installer = rewritePackageLockForNpm(JSON.parse(readFileSync(installerPath, "utf8")), rewriteOptions);
		addPayloadDependencies({ version: rewritten.version, optionalDependencies: rewritten.optionalDependencies }, installer, `node_modules/${rewritten.name}`);
		writeFileSync(installerPath, `${JSON.stringify(installer, null, "\t")}\n`);
		const installerManifestPath = join(dest, "install-lock", "package.json");
		const installerManifest = JSON.parse(readFileSync(installerManifestPath, "utf8"));
		installerManifest.name = installer.name;
		installerManifest.version = installer.version;
		installerManifest.dependencies = installer.packages[""].dependencies;
		writeFileSync(installerManifestPath, `${JSON.stringify(installerManifest, null, "\t")}\n`);
	}
	assertPublishedEntryPointsExist(dest, rewritten, rewritten.name);
	assertPublishedTreeHasNoEarendil(dest, rewritten.name);
	return { dest, publishedName: rewritten.name, version: rewritten.version };
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.workspaceName) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.workspaceName}`);
	}
	if (!packageNames[pkg.workspaceName]) {
		throw new Error(`missing npm mapping for ${pkg.workspaceName}`);
	}
	packageVersions.set(pkg.workspaceName, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

if (options.channel === "dev" && !options.version.startsWith(`${versions[0]}-dev.`)) {
	throw new Error(`Dev version must start with ${versions[0]}-dev.`);
}
const publishVersion = options.version ?? versions[0];

if (!dryRun && options.channel === "stable" && computerRelease.approval !== "production-approved") {
	throw new Error("Computer-use runtime has development-only approval. Production publication is blocked.");
}

if (requireQualify) {
	const sha = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
	const state = qualifyStatus(sha);
	console.log(`Release qualification ${QUALIFY_STATUS_CONTEXT} on ${sha}: ${state}`);
	if (state !== "success" && !dryRun) {
		throw new Error(`${sha} has no passing release qualification. Run \`npm run qualify -- --profile <signed-in agent dir>\` on this commit.`);
	}
}

console.log(`Publishing ${options.channel} lunR packages at ${publishVersion} as @ashx-j/*${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	publishedName: packageNames[pkg.workspaceName],
	published: false,
	publishTag: publishTagFor(pkg.workspaceName, options.channel),
	version: publishVersion,
}));

const manifest = [];

await (async () => {
	const temps = [];
	try {
		const payloadRoot = mkdtempSync(join(tmpdir(), "lunr-payload-publish-"));
		temps.push(payloadRoot);
		const payloads = await stagePayloadPackages(payloadRoot, publishVersion);
		const payloadStates = payloads.map(({ directory, manifest }) => ({
			stageDir: directory, publishedName: manifest.name, version: manifest.version, published: false,
			publishTag: options.channel === "dev" ? "dev" : "latest",
		}));
		for (const pkg of packageStates) {
			assertBuildOutputExists(pkg.directory);
			pkg.published = dryRun ? false : await isPublished(pkg.publishedName, pkg.version);

			const staged = copyPackageForPublish(pkg.directory);
			temps.push(staged.dest);
			pkg.stageDir = staged.dest;

			if (dryRun) {
				console.log(`${pkg.publishedName}@${pkg.version}: validating local release copy without querying publication state.`);
			} else if (pkg.published) {
				console.log(`${pkg.publishedName}@${pkg.version} is already published; validating pack only.`);
			} else {
				console.log(`${pkg.publishedName}@${pkg.version} is not published; validating pack.`);
			}

			const result = run("npm", ["pack", ...(packDirectory ? ["--pack-destination", packDirectory] : ["--dry-run"]), "--ignore-scripts", "--json"], {
				capture: true,
				cwd: pkg.stageDir,
			});
			const packed = Object.values(JSON.parse(result.stdout))[0];
			console.log(
				`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked\n`,
			);
			manifest.push({ name: pkg.publishedName, version: pkg.version, integrity: packed.integrity });
		}

		for (const pkg of payloadStates) {
			pkg.published = dryRun ? false : await isPublished(pkg.publishedName, pkg.version);
			const result = run("npm", ["pack", ...(packDirectory ? ["--pack-destination", packDirectory] : ["--dry-run"]), "--ignore-scripts", "--json"], { capture: true, cwd: pkg.stageDir });
			const packed = Object.values(JSON.parse(result.stdout))[0];
			console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
			manifest.push({ name: pkg.publishedName, version: pkg.version, integrity: packed.integrity });
		}
		if (manifestPath) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
		if (dryRun) return;
		if (packageStates.find((pkg) => pkg.workspaceName === "@earendil-works/pi-coding-agent").published && payloadStates.some((pkg) => !pkg.published)) {
			throw new Error("Use a new lunR release version before publishing new optional payload packages.");
		}

		console.log("All packages validated; starting publication.\n");

		for (const pkg of [...payloadStates, ...packageStates]) {
			if (pkg.published) {
				console.log(`Skipping ${pkg.publishedName}@${pkg.version}: already published\n`);
				continue;
			}

			run("npm", ["publish", "--access", "public", "--ignore-scripts", "--tag", pkg.publishTag], { cwd: pkg.stageDir });
			await waitForPublished(pkg.publishedName, pkg.version);
			console.log();
		}
	} finally {
		for (const dir of temps) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
})();
