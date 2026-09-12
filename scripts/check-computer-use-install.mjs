import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { release } from "./computer-use-packages.mjs";
import { verifyComputerUseArchive } from "./check-computer-use-release.mjs";

const packs = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/check-computer-use-install.mjs <public-package-tarball-directory>");
const root = await mkdtemp(join(tmpdir(), "lunr-native-install-"));
const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
const packages = new Map();
for (const file of await readdir(packs)) {
	if (!file.endsWith(".tgz")) continue;
	const path = join(packs, file);
	const manifest = JSON.parse(execFileSync(tar, ["-xOf", path, "package/package.json"], { encoding: "utf8" }));
	if (!manifest.name.startsWith("@ashx-j/lunr")) continue;
	packages.set(manifest.name, { path, file, manifest, integrity: `sha512-${createHash("sha512").update(await readFile(path)).digest("base64")}` });
}
assert.equal(packages.size, 7, "Pack all four public packages and three native payload packages first.");
const cli = packages.get("@ashx-j/lunr") ?? packages.get("@ashx-j/lunr-dev");
assert.ok(cli, "Missing stable or dev CLI tarball");
const cliName = cli.manifest.name;
const cliEntry = Object.values(cli.manifest.bin)[0];
const downloads = [];
const server = createServer((request, response) => {
	const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname).slice(1);
	const item = packages.get(path);
	if (item) {
		const manifest = { ...item.manifest, dist: { tarball: `${registry}${item.manifest.name}/-/${item.file}`, integrity: item.integrity } };
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: manifest } }));
		return;
	}
	const payload = [...packages.values()].find((value) => path === `${value.manifest.name}/-/${value.file}` || path === `${value.manifest.name}/-/${value.manifest.name.split("/")[1]}-${value.manifest.version}.tgz`);
	if (payload) {
		downloads.push(payload.manifest.name);
		createReadStream(payload.path).pipe(response);
		return;
	}
	response.writeHead(302, { Location: `https://registry.npmjs.org/${path}` });
	response.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const registry = `http://127.0.0.1:${server.address().port}/`;
const profile = join(root, "profile");
await mkdir(profile);
const userconfig = join(profile, "npmrc");
await writeFile(userconfig, "");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI_SUBAGENT|CUA_|NPM_CONFIG_|NODE_AUTH_TOKEN|NPM_TOKEN)/i.test(key)));
Object.assign(env, { HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: join(profile, "agent"), npm_config_userconfig: userconfig, npm_config_registry: registry, npm_config_cache: join(root, "npm-cache") });
async function run(command, args, cwd) {
	await new Promise((done, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" && command === "npm.cmd" });
		const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, 240000);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("exit", (code) => { clearTimeout(timer); code === 0 ? done() : reject(new Error(`${command} exited ${code}`)); });
	});
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
try {
	const install = join(root, "install");
	await mkdir(install);
	await writeFile(join(install, "package.json"), JSON.stringify({ private: true, dependencies: { [cliName]: cli.manifest.version } }));
	await run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], install);
	const host = release.artifacts.find((artifact) => artifact.platform === process.platform && artifact.arch === process.arch);
	assert.deepEqual([...new Set(downloads.filter((name) => name.startsWith("@ashx-j/lunr-computer-")))], host ? [host.packageName] : []);
	assert.equal(cli.manifest.optionalDependencies[host?.packageName ?? release.artifacts[0].packageName], cli.manifest.version);
	const relocated = join(root, "relocated");
	await rename(install, relocated);
	const packageRoot = join(relocated, "node_modules", cliName);
	assert.deepEqual(await readdir(join(packageRoot, "native", "computer-use")), ["LICENSE.md"]);
	const { resolveRuntimeArchive } = await import(pathToFileURL(join(packageRoot, "dist", "core", "computer-use", "runtime.js")).href);
	if (host) {
		const { archive } = await resolveRuntimeArchive(packageRoot);
		assert.ok(archive.startsWith(relocated));
		await verifyComputerUseArchive(dirname(archive), host);
	}
	await assert.rejects(resolveRuntimeArchive(packageRoot, "linux", "x64"), /unsupported/);
	await run(process.execPath, ["scripts/check-interactive-first-paint.mjs", join(packageRoot, cliEntry)], fileURLToPath(new URL("../", import.meta.url)));
	console.log("Relocated public-name installation: ignore-scripts, host-only payload, archive hash and first requests passed.");

	for (const [platform, arch] of [["win32", "x64"], ["win32", "arm64"], ["darwin", "arm64"], ["linux", "x64"]]) {
		const directory = join(root, `selection-${platform}-${arch}`);
		await mkdir(directory);
		await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, optionalDependencies: Object.fromEntries(release.artifacts.map((artifact) => [artifact.packageName, cli.manifest.version])) }));
		await run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${platform}`, `--cpu=${arch}`], directory);
		for (const artifact of release.artifacts) {
			const path = join(directory, "node_modules", artifact.packageName, "package.json");
			if (artifact.platform === platform && artifact.arch === arch) assert.equal(JSON.parse(await readFile(path, "utf8")).name, artifact.packageName);
			else await assert.rejects(readFile(path), { code: "ENOENT" });
		}
	}
	const omitted = join(root, "omitted");
	await mkdir(omitted);
	await writeFile(join(omitted, "package.json"), JSON.stringify({ version: cli.manifest.version, optionalDependencies: Object.fromEntries(release.artifacts.map((artifact) => [artifact.packageName, cli.manifest.version])) }));
	await run(npm, ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund"], omitted);
	await assert.rejects(resolveRuntimeArchive(omitted, "win32", "x64"), /payload is missing/);
	console.log("OS/CPU selection for all supported targets and Linux, plus omitted optional dependencies passed.");

	const installer = join(root, "installer");
	await mkdir(installer);
	for (const file of ["package.json", "package-lock.json"]) await copyFile(join(packageRoot, "install-lock", file), join(installer, file));
	await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], installer);
	if (host) await verifyComputerUseArchive(dirname((await resolveRuntimeArchive(join(installer, "node_modules", cliName))).archive), host);
	console.log("Staged standalone installer lock: npm ci --ignore-scripts passed with correct payload.");
} finally {
	await new Promise((done) => server.close(done));
	await rm(root, { recursive: true, force: true });
}
