import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const candidateVersion = "1.2.0-beta.15";

export function npmCliPath() {
	const nodeDir = dirname(process.execPath);
	for (const path of [
		join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
		join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
	]) {
		if (existsSync(path)) return path;
	}
	throw new Error(`Cannot find npm CLI next to ${process.execPath}`);
}

export async function isolatedNpmEnvironment(profileDir) {
	await mkdir(profileDir, { recursive: true });
	const npmrc = join(profileDir, "npmrc");
	const globalNpmrc = join(profileDir, "global-npmrc");
	await writeFile(npmrc, "registry=https://registry.npmjs.org/\n");
	await writeFile(globalNpmrc, "");
	return {
		PATH: process.env.PATH ?? "",
		SystemRoot: process.env.SystemRoot ?? "",
		HOME: profileDir,
		USERPROFILE: profileDir,
		APPDATA: profileDir,
		LOCALAPPDATA: profileDir,
		TMP: profileDir,
		TEMP: profileDir,
		TMPDIR: profileDir,
		npm_config_userconfig: npmrc,
		npm_config_globalconfig: globalNpmrc,
		npm_config_registry: "https://registry.npmjs.org/",
	};
}

export async function installCandidate(installDir, profileDir) {
	await mkdir(installDir, { recursive: true });
	const env = await isolatedNpmEnvironment(profileDir);
	execFileSync(process.execPath, [npmCliPath(), "install", "--prefix", installDir, "--no-audit", "--no-fund", "--no-package-lock", "--save=false", `@lydell/node-pty@${candidateVersion}`], {
		cwd: profileDir,
		env,
		stdio: "pipe",
		timeout: 120_000,
	});
	const selected = `node-pty-${process.platform}-${process.arch}`;
	const wrapper = JSON.parse(await readFile(join(installDir, "node_modules", "@lydell", "node-pty", "package.json"), "utf8"));
	const native = JSON.parse(await readFile(join(installDir, "node_modules", "@lydell", selected, "package.json"), "utf8"));
	for (const manifest of [wrapper, native]) {
		assert.equal(manifest.version, candidateVersion);
		for (const name of ["preinstall", "install", "postinstall"]) assert.equal(manifest.scripts?.[name], undefined, `${manifest.name} has ${name} compiler fallback`);
	}
	assert.equal(wrapper.optionalDependencies[`@lydell/${selected}`], candidateVersion);
	return { selectedPackage: native.name, scriptsEnabled: true, lifecycleHooksAbsent: true };
}
