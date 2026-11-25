import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { getPackageDir } from "../../config.ts";

import { computerRelease } from "./release.generated.ts";

const exec = promisify(execFile);
export const CUA_VERSION = computerRelease.version;
const tar =
	process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
type Payload = (typeof computerRelease.artifacts)[number];

/** Where and how resolveRuntimeArchive fetches a payload the install does not carry. */
export interface RuntimeDownload {
	registry?: string;
	signal?: AbortSignal;
	/** Called once, before a download starts. */
	onDownload?: (message: string) => void;
}

// npm installs every platform's optional packages from a dependency's shrinkwrap, so the
// payload packages are published but not depended on. The host's archive is fetched from its
// payload package once and kept only if it matches the pinned size and SHA-256.
async function downloadRuntimeArchive(payload: Payload, version: string, options: RuntimeDownload): Promise<string> {
	const cache = join(userInfo().homedir, ".lunr", "desktop", "payload");
	const cached = join(cache, payload.name);
	try {
		const info = await lstat(cached);
		if (info.isFile() && info.size === payload.bytes) return cached;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
	const url = `${registry}/${payload.packageName}/-/${payload.packageName.split("/")[1]}-${version}.tgz`;
	options.onDownload?.(
		`Downloading the computer-use runtime for ${payload.platform}/${payload.arch} (${Math.round(payload.bytes / 1e6)} MB). This happens once.`,
	);
	await assertOwnedPath(cache);
	await mkdir(cache, { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(join(cache, "download-"));
	try {
		const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(300000)]);
		const response = await fetch(url, { signal });
		if (!response.ok || !response.body)
			throw new Error(`Computer-use runtime download failed: HTTP ${response.status} for ${url}`);
		const tarball = join(temporary, "payload.tgz");
		await pipeline(Readable.fromWeb(response.body), createWriteStream(tarball), { signal });
		await exec(tar, ["-xzf", tarball, "-C", temporary, `package/${payload.name}`], {
			timeout: 30000,
			windowsHide: true,
			signal,
		});
		const archive = join(temporary, "package", payload.name);
		const info = await lstat(archive);
		if (!info.isFile() || info.size !== payload.bytes || (await digest(archive, signal)) !== payload.sha256)
			throw new Error("Downloaded computer-use archive failed size or SHA-256 verification.");
		await rename(archive, cached);
		return cached;
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

export async function resolveRuntimeArchive(
	packageDirectory = getPackageDir(),
	platform: string = process.platform,
	arch: string = process.arch,
	download?: RuntimeDownload,
): Promise<{ archive: string; sha256: string }> {
	const payload = computerRelease.artifacts.find((item) => item.platform === platform && item.arch === arch);
	if (!payload) throw new Error("Computer use is unsupported on this platform or architecture.");
	let archive = join(packageDirectory, "native", "computer-use", payload.name);
	try {
		await lstat(archive);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const cli = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
		let manifestPath: string | undefined;
		try {
			manifestPath = createRequire(join(packageDirectory, "package.json")).resolve(
				`${payload.packageName}/package.json`,
			);
		} catch {
			if (!download) throw new Error("Computer-use payload is missing. No runtime was downloaded.");
		}
		if (manifestPath) {
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			if (manifest.name !== payload.packageName || manifest.version !== cli.version)
				throw new Error(
					"Computer-use payload package version does not match lunR. Reinstall lunR with optional dependencies enabled.",
				);
			archive = join(dirname(manifestPath), payload.name);
		} else if (download) archive = await downloadRuntimeArchive(payload, cli.version, download);
	}
	const info = await lstat(archive);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== payload.bytes)
		throw new Error("Bundled computer-use archive is not a regular file of the pinned size.");
	return { archive, sha256: payload.sha256 };
}

export function runtimeEnvironment(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
	return {
		...Object.fromEntries(
			Object.entries(inherited).filter(
				(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].toUpperCase().startsWith("CUA_"),
			),
		),
		CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
		CUA_DRIVER_RS_UPDATE_CHECK: "false",
		CUA_DRIVER_PERMISSION_MODE: "standard",
		CUA_DRIVER_DISABLE_UNRESTRICTED: "true",
	};
}

async function digest(path: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
	return hash.digest("hex");
}

export async function assertOwnedPath(path: string): Promise<void> {
	let current = resolve(path);
	for (;;) {
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink() || resolve(await realpath(current)).toLowerCase() !== current.toLowerCase()) {
				throw new Error(`Computer runtime path redirects elsewhere: ${current}`);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

export async function runtimeInventory(root: string, signal?: AbortSignal): Promise<Record<string, string>> {
	const inventory: Record<string, string> = {};
	async function walk(path: string): Promise<void> {
		for (const item of await readdir(path, { withFileTypes: true })) {
			const entry = join(path, item.name);
			const key = relative(root, entry);
			if (item.isSymbolicLink()) {
				const target = await readlink(entry);
				const resolved = relative(root, resolve(dirname(entry), target));
				if (
					isAbsolute(target) ||
					resolved === ".." ||
					resolved.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
					isAbsolute(resolved)
				)
					throw new Error("Runtime symlink escapes its bundle.");
				inventory[key] = `link:${target}`;
			} else if (item.isDirectory()) {
				await assertOwnedPath(entry);
				inventory[key] = "directory";
				await walk(entry);
			} else if (item.isFile()) {
				await assertOwnedPath(entry);
				inventory[key] = await digest(entry, signal);
			} else throw new Error("Unexpected runtime filesystem entry.");
		}
	}
	await walk(root);
	return Object.fromEntries(Object.entries(inventory).sort(([a], [b]) => a.localeCompare(b)));
}

export async function installRuntime(
	signal?: AbortSignal,
	onDownload?: (message: string) => void,
): Promise<{ command: string; app?: string }> {
	signal?.throwIfAborted();
	const platform = `${process.platform}-${process.arch}`;
	const { archive, sha256 } = await resolveRuntimeArchive(undefined, undefined, undefined, { signal, onDownload });
	// A first-use download has its own bound; the 60 s bound covers verification and extraction.
	signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60000)]);
	if (process.platform === "win32" && process.env.SESSIONNAME === "Services")
		throw new Error("Computer use requires a logged-in interactive desktop.");
	if ((await digest(archive, signal)) !== sha256)
		throw new Error("Bundled computer-use archive failed SHA-256 verification.");
	const root = join(userInfo().homedir, ".lunr", "desktop");
	await assertOwnedPath(root);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(root, { retries: 0, stale: 120000 });
	const temporary = join(root, `extract-${randomUUID()}`);
	const destination = join(root, `runtime-${platform}`);
	try {
		await assertOwnedPath(destination);
		await mkdir(temporary, { mode: 0o700 });
		await exec(tar, ["-xf", archive, "-C", temporary], { timeout: 30000, windowsHide: true, signal });
		const extracted =
			process.platform === "darwin" ? join(temporary, `cua-driver-rs-${CUA_VERSION}-darwin-arm64`) : temporary;
		const expected = await runtimeInventory(extracted, signal);
		try {
			await lstat(destination);
			if (JSON.stringify(await runtimeInventory(destination, signal)) !== JSON.stringify(expected))
				throw new Error(
					"Cached computer runtime differs from the verified archive. Remove the inactive lunR runtime directory before reinstalling; it was not executed or overwritten.",
				);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			await rename(extracted, destination);
		}
		signal?.throwIfAborted();
		if (process.platform === "darwin") {
			const app = join(destination, "CuaDriver.app");
			await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 15000, signal });
			return { app, command: join(app, "Contents", "MacOS", "cua-driver") };
		}
		return { command: join(destination, "cua-driver.exe") };
	} finally {
		await rm(temporary, { recursive: true, force: true });
		await release();
	}
}
