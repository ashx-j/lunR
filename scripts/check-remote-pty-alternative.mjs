import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCandidate } from "./remote-pty-probe-install.mjs";

const version = "1.2.0-beta.15";
const name = "@lydell/node-pty";
const targets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"];
const pinnedIntegrity = {
	wrapper: "sha512-Br8wBxzbxFwdWgk9uQ+rdzE0xfoxOK4QuGH54swhRwc5IxP6H9Y1/bcyazRGvNUs6XkB5qNVkezuKSRxUwZe7A==",
	"darwin-x64": "sha512-yDT2oqPqYMBScyuk1U9Rg5VKcrbMOD9o9jWYYamDADA3NSbUISroPChrqYRQ74Y7BQtNH4gqYAiWOZRi5uQZ0Q==",
	"darwin-arm64": "sha512-6TSBbzdcLiNTHl1mTuzflqXrkmcC36USVGvERoDgvHk2ItEDaMaFZuAJ1CqPmwYj0DyhCS16TVS8OGK9xZnjyQ==",
	"linux-x64": "sha512-+U/5AVvHT6W+8OCYcnJgN0Qgc0ycO3TfD6aaFJHK+WHij797f8gsi5dV1HEO9l6YQmWCD+VL5gaLDhx3mxHwCA==",
	"linux-arm64": "sha512-wkbNF7dYAmtJv+o2+iztVlNwnUB4B0uX0wh/UD+mwMcmE2gNMnW9GChXO7fEE5XJokD0vB5idiHpGegaN+G/sg==",
	"win32-x64": "sha512-2f8twEmDVxZ7drchAXjtevpmSPhFok0avAnzXro4t5gmz0xsPNKkoZvymwtuIS3xo7PzQqZOPQ/YzwEMb7oIzQ==",
	"win32-arm64": "sha512-pyAk91w7wnnKrD4mrHXtIXRfmzSWV5bEzvRhurXcMCtCc2TJ424ciUskIgWMhAPP6y3KyUnqElj+U6kY3iOt0A==",
};
const directory = await mkdtemp(join(tmpdir(), "lunr-pty-alternative-"));
const record = { candidate: `${name}@${version}`, observer: { platform: process.platform, arch: process.arch, node: process.version }, matrix: [], runtime: "not-run" };

async function metadata(packageName) {
	const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${version}`, { signal: AbortSignal.timeout(30_000) });
	assert.ok(response.ok, `${packageName}: registry HTTP ${response.status}`);
	return response.json();
}

async function inspect(packageName, expectedTarget) {
	const manifest = await metadata(packageName);
	assert.equal(manifest.version, version);
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.dist.integrity, pinnedIntegrity[expectedTarget ?? "wrapper"]);
	assert.ok(!manifest.scripts?.install && !manifest.scripts?.postinstall && !manifest.scripts?.preinstall, `${packageName}: unexpected install lifecycle script`);
	if (expectedTarget) {
		const [os, cpu] = expectedTarget.split("-");
		assert.deepEqual(manifest.os, [os]);
		assert.deepEqual(manifest.cpu, [cpu]);
	}
	const response = await fetch(manifest.dist.tarball, { signal: AbortSignal.timeout(60_000) });
	assert.ok(response.ok, `${packageName}: tarball HTTP ${response.status}`);
	const archive = Buffer.from(await response.arrayBuffer());
	assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, manifest.dist.integrity);
	const filename = `${expectedTarget ?? "wrapper"}.tgz`;
	await writeFile(join(directory, filename), archive);
	const members = execFileSync("tar", ["-tzf", filename], { cwd: directory, encoding: "utf8", timeout: 30_000 }).split(/\r?\n/).filter(Boolean);
	const nativeFiles = members.filter((member) => member.endsWith(".node"));
	if (expectedTarget) assert.ok(nativeFiles.length > 0, `${packageName}: no native addon`);
	return { name: packageName, integrity: manifest.dist.integrity, bytes: archive.length, nativeFiles, helpers: members.filter((member) => /(?:spawn-helper|OpenConsole\.exe|conpty\.dll|winpty-agent\.exe|winpty\.dll)$/.test(member)) };
}

try {
	const wrapper = await inspect(name);
	const wrapperManifest = await metadata(name);
	record.wrapper = wrapper;
	for (const target of targets) {
		const packageName = `@lydell/node-pty-${target}`;
		assert.equal(wrapperManifest.optionalDependencies?.[packageName], version, `${target}: not pinned as optional dependency`);
		record.matrix.push({ target, ...await inspect(packageName, target), runtimeVerified: false });
	}
	assert.ok(!wrapperManifest.scripts?.install && !wrapperManifest.scripts?.postinstall);
	const install = join(directory, "install");
	record.cleanInstall = await installCandidate(install, directory);
	const installedManifest = JSON.parse(await readFile(join(install, "node_modules", "@lydell", "node-pty", "package.json"), "utf8"));
	assert.equal(installedManifest.version, version);
	const expected = record.matrix.find((row) => row.target === `${process.platform}-${process.arch}`);
	assert.ok(expected, "observer is outside the six-target matrix");
	const probe = fileURLToPath(new URL("./remote-pty-runtime-probe.cjs", import.meta.url));
	record.runtime = JSON.parse(execFileSync(process.execPath, [probe, install, directory], { cwd: directory, encoding: "utf8", timeout: 15_000 }));
	expected.runtimeVerified = true;
} catch (error) {
	record.failure = String(error?.stack ?? error);
	process.exitCode = 1;
} finally {
	console.log(JSON.stringify(record, null, 2));
	await rm(directory, { recursive: true, force: true });
}
