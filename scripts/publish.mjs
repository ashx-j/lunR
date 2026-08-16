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
import { assertNoEarendil, npmNameFor, rewritePackageJsonForNpm, rewriteWorkspaceSpecifiers } from "./lunr-npm-names.mjs";

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
			const after = rewriteWorkspaceSpecifiers(before);
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

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

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
		throw new Error(`${directory}/dist does not exist. Build with tsgo before publishing.`);
	}
}

async function isPublished(name, version) {
	const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
	const res = await fetch(url);
	if (res.status === 404) return false;
	if (!res.ok) {
		throw new Error(`Failed to query ${name}@${version}: HTTP ${res.status}`);
	}
	return true;
}

function copyPackageForPublish(directory) {
	const dest = mkdtempSync(join(tmpdir(), "lunr-publish-"));
	cpSync(directory, dest, {
		recursive: true,
		filter: (src) => {
			const norm = src.replaceAll("\\", "/");
			if (norm.includes("/node_modules")) return false;
			if (norm.includes("/binaries")) return false;
			if (norm.endsWith("npm-shrinkwrap.json")) return false;
			return true;
		},
	});
	const sourcePkg = readPackageJson(directory);
	const rewritten = rewritePackageJsonForNpm(sourcePkg);
	if (rewritten.repository && rewritten.repository.directory === undefined) {
		delete rewritten.repository.directory;
	}
	writeFileSync(join(dest, "package.json"), `${JSON.stringify(rewritten, null, "\t")}\n`, "utf8");
	rewritePublishedTree(dest);
	const stagedMain = join(dest, "dist", "main.js");
	if (existsSync(stagedMain)) {
		assertNoEarendil(readFileSync(stagedMain, "utf8"), `${rewritten.name} dist/main.js`);
	}
	return { dest, publishedName: rewritten.name, version: rewritten.version };
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.workspaceName) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.workspaceName}`);
	}
	if (!npmNameFor(pkg.workspaceName)) {
		throw new Error(`missing npm mapping for ${pkg.workspaceName}`);
	}
	packageVersions.set(pkg.workspaceName, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(`Publishing lunR packages at ${versions[0]} as @ashx-j/*${dryRun ? " (dry run)" : ""}\n`);

const packageStates = packages.map((pkg) => ({
	...pkg,
	publishedName: npmNameFor(pkg.workspaceName),
	published: false,
	version: packageVersions.get(pkg.workspaceName),
}));

await (async () => {
	const temps = [];
	try {
		for (const pkg of packageStates) {
			assertBuildOutputExists(pkg.directory);
			pkg.published = await isPublished(pkg.publishedName, pkg.version);

			const staged = copyPackageForPublish(pkg.directory);
			temps.push(staged.dest);
			pkg.stageDir = staged.dest;

			if (pkg.published) {
				console.log(`${pkg.publishedName}@${pkg.version} is already published; validating pack only.`);
			} else {
				console.log(`${pkg.publishedName}@${pkg.version} is not published; validating pack.`);
			}

			const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
				capture: true,
				cwd: pkg.stageDir,
			});
			const packed = JSON.parse(result.stdout)[0];
			console.log(
				`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked\n`,
			);
		}

		if (dryRun) {
			return;
		}

		console.log("All packages validated; starting publication.\n");

		for (const pkg of packageStates) {
			if (pkg.published) {
				console.log(`Skipping ${pkg.publishedName}@${pkg.version}: already published\n`);
				continue;
			}

			run("npm", ["publish", "--access", "public", "--ignore-scripts"], { cwd: pkg.stageDir });
			console.log();
		}
	} finally {
		for (const dir of temps) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
})();
