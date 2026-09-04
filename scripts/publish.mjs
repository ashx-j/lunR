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
import {
	assertNoEarendil,
	DEV_WORKSPACE_TO_NPM,
	publishTagFor,
	rewritePackageJsonForNpm,
	rewriteWorkspaceSpecifiers,
	WORKSPACE_TO_NPM,
} from "./lunr-npm-names.mjs";

const REWRITE_EXT = new Set([".js", ".mjs", ".cjs", ".d.ts", ".ts", ".map", ".json"]);

function shouldRewriteFile(filePath) {
	const norm = filePath.replaceAll("\\", "/");
	if (norm.includes("/node_modules/")) return false;
	for (const ext of REWRITE_EXT) {
		if (norm.endsWith(ext)) return true;
	}
	return false;
}

function rewritePublishedTree(root, packageNames) {
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

function parseArgs() {
	const options = { channel: "stable", dryRun: false, version: undefined };
	const args = process.argv.slice(2);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--channel") {
			const channel = args[++index];
			if (channel !== "stable" && channel !== "dev") throw new Error("--channel must be stable or dev");
			options.channel = channel;
		} else if (arg === "--version") {
			const version = args[++index];
			if (!version) throw new Error("--version requires a value");
			options.version = version;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (options.channel === "stable" && options.version) {
		throw new Error("Stable publication reads versions from package.json; do not pass --version");
	}
	if (options.channel === "dev" && !/^\d+\.\d+\.\d+-dev\.\d+\.\d+$/.test(options.version ?? "")) {
		throw new Error("Dev publication requires --version <base>-dev.<run>.<attempt>");
	}
	return options;
}

const options = parseArgs();
const dryRun = options.dryRun;
const packageNames = options.channel === "dev" ? DEV_WORKSPACE_TO_NPM : WORKSPACE_TO_NPM;

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
	const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}?cache=${Date.now()}`;
	const res = await fetch(url, { cache: "no-store" });
	if (res.status === 404) return false;
	if (!res.ok) {
		throw new Error(`Failed to query ${name}@${version}: HTTP ${res.status}`);
	}
	return true;
}

async function waitForPublished(name, version) {
	for (let attempt = 1; attempt <= 12; attempt++) {
		if (await isPublished(name, version)) return;
		if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	throw new Error(`${name}@${version} was not visible on npm after publication`);
}

function copyPackageForPublish(directory, workspaceName) {
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
	const isDevCli = options.channel === "dev" && workspaceName === "@earendil-works/pi-coding-agent";
	if (isDevCli) cpSync(join("scripts", "lunr-dev-readme.md"), join(dest, "README.md"));
	const rewritten = rewritePackageJsonForNpm(sourcePkg, {
		packageNames,
		version: options.version,
		workspaceDependencyVersion: options.version,
		bin: isDevCli ? { "lunr-dev": "dist/dev-cli.js" } : undefined,
		appName: isDevCli ? "lunr-dev" : undefined,
	});
	if (rewritten.repository && rewritten.repository.directory === undefined) {
		delete rewritten.repository.directory;
	}
	writeFileSync(join(dest, "package.json"), `${JSON.stringify(rewritten, null, "\t")}\n`, "utf8");
	rewritePublishedTree(dest, packageNames);
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
	if (!packageNames[pkg.workspaceName]) {
		throw new Error(`missing npm mapping for ${pkg.workspaceName}`);
	}
	packageVersions.set(pkg.workspaceName, packageJson.version);
}

const sourceVersions = [...new Set(packageVersions.values())];
if (sourceVersions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${sourceVersions.join(", ")}`);
}
if (options.channel === "dev" && !options.version?.startsWith(`${sourceVersions[0]}-dev.`)) {
	throw new Error(`Dev version must use the package version as its base: ${sourceVersions[0]}-dev.<run>.<attempt>`);
}
const publishVersion = options.version ?? sourceVersions[0];

console.log(
	`Publishing ${options.channel} lunR packages at ${publishVersion} as @ashx-j/*${dryRun ? " (dry run)" : ""}\n`,
);

const packageStates = packages.map((pkg) => ({
	...pkg,
	publishedName: packageNames[pkg.workspaceName],
	published: false,
	publishTag: publishTagFor(pkg.workspaceName, options.channel),
	version: publishVersion,
}));

await (async () => {
	const temps = [];
	try {
		for (const pkg of packageStates) {
			assertBuildOutputExists(pkg.directory);
			pkg.published = await isPublished(pkg.publishedName, pkg.version);

			const staged = copyPackageForPublish(pkg.directory, pkg.workspaceName);
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

			const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
			if (pkg.publishTag) publishArgs.push("--tag", pkg.publishTag);
			run("npm", publishArgs, { cwd: pkg.stageDir });
			await waitForPublished(pkg.publishedName, pkg.version);
			console.log();
		}
	} finally {
		for (const dir of temps) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
})();
