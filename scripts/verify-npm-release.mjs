#!/usr/bin/env node
/**
 * Verify a finished npm release: every registry tarball must match the integrity that
 * scripts/publish.mjs recorded with --manifest, and a fresh isolated global install of
 * @ashx-j/lunr must report the released version.
 *
 * npm accepts a publish minutes before its metadata and tarballs resolve, so missing
 * metadata, missing tarballs and failed installs are retried until the deadline. An
 * integrity mismatch fails at once: published bytes never change.
 *
 * Usage: node scripts/verify-npm-release.mjs <manifest.json> [--timeout-minutes <n>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const REGISTRY = "https://registry.npmjs.org";
const RETRY_MS = 15_000;

const manifestPath = process.argv[2];
const timeoutIndex = process.argv.indexOf("--timeout-minutes");
const timeoutMinutes = timeoutIndex === -1 ? 10 : Number(process.argv[timeoutIndex + 1]);
if (!manifestPath || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
	console.error("Usage: node scripts/verify-npm-release.mjs <manifest.json> [--timeout-minutes <n>]");
	process.exit(1);
}
const deadline = Date.now() + timeoutMinutes * 60_000;

/** @type {{ name: string; version: string; integrity: string }[]} */
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest) || manifest.length === 0) throw new Error(`${manifestPath} lists no packages.`);

/** Run `attempt` until it returns true or the deadline passes. */
async function retry(label, attempt) {
	for (;;) {
		const result = await attempt();
		if (result === true) return;
		if (Date.now() + RETRY_MS > deadline) throw new Error(`${label}: still failing at the deadline (${result}).`);
		console.log(`${label}: ${result}; retrying in ${RETRY_MS / 1000}s`);
		await delay(RETRY_MS);
	}
}

function integrityOf(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function verifyTarball({ name, version, integrity }) {
	const label = `${name}@${version}`;
	await retry(label, async () => {
		const metadata = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`);
		if (!metadata.ok) return `metadata HTTP ${metadata.status}`;
		const dist = (await metadata.json()).dist;
		if (dist?.integrity !== integrity) {
			throw new Error(`${label}: registry integrity ${dist?.integrity} does not match the packed ${integrity}.`);
		}
		const tarball = await fetch(dist.tarball);
		if (!tarball.ok) return `tarball HTTP ${tarball.status}`;
		const actual = integrityOf(Buffer.from(await tarball.arrayBuffer()));
		if (actual !== integrity) throw new Error(`${label}: downloaded tarball is ${actual}, expected ${integrity}.`);
		return true;
	});
	console.log(`${label}: registry tarball matches ${integrity}`);
}

async function verifyFreshInstall(version) {
	const root = mkdtempSync(join(tmpdir(), "lunr-release-verify-"));
	try {
		const home = join(root, "home");
		const prefix = join(root, "prefix");
		mkdirSync(home, { recursive: true });
		const userconfig = join(root, "npmrc");
		writeFileSync(userconfig, "");
		const env = {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			npm_config_cache: join(root, "cache"),
			npm_config_userconfig: userconfig,
			npm_config_prefix: prefix,
			PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
		};
		const label = `fresh install of @ashx-j/lunr@${version}`;
		await retry(label, async () => {
			const install = spawnSync("npm", ["install", "--global", `@ashx-j/lunr@${version}`], {
				env,
				encoding: "utf8",
			});
			if (install.status !== 0) return `npm install exited ${install.status}: ${install.stderr.trim().split("\n").at(-1)}`;
			const run = spawnSync(join(prefix, "bin", "lunr"), ["--version"], { env, encoding: "utf8" });
			const reported = run.stdout.trim();
			if (run.status !== 0) return `lunr --version exited ${run.status}: ${run.stderr.trim()}`;
			if (reported !== version) throw new Error(`${label}: lunr --version reported ${reported}.`);
			return true;
		});
		console.log(`${label}: lunr --version reports ${version}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

for (const entry of manifest) await verifyTarball(entry);
const cli = manifest.find((entry) => entry.name === "@ashx-j/lunr");
if (!cli) throw new Error(`${manifestPath} has no @ashx-j/lunr entry.`);
await verifyFreshInstall(cli.version);
console.log("Release verified.");
