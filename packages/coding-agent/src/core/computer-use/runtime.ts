import { exec as execCommand, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { getPackageDir } from "../../config.ts";

import { computerRelease } from "./release.generated.ts";

const exec = promisify(execFile);
export const CUA_VERSION = computerRelease.version;
const tar =
	process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
type Payload = (typeof computerRelease.artifacts)[number];

/** Bytes of the runtime package tarball received so far, and the most it can hold. */
export interface DownloadProgress {
	received: number;
	total: number;
}

/** Options for downloadRuntimeArchive. registry overrides the npm-configured registry (tests). */
export interface RuntimeDownload {
	registry?: string;
	/** Aborts the download; the partial file stays so the next attempt resumes. */
	signal?: AbortSignal;
	onProgress?: (progress: DownloadProgress) => void;
}

/** Abort a download that receives nothing for this long. A slow link stays within it. */
const STALL_MS = 60_000;
/** The tarball wraps one already-compressed archive, a license and a manifest. */
const TARBALL_SLACK_BYTES = 64 * 1024;
const NPMJS = "https://registry.npmjs.org";

function payloadFor(platform: string, arch: string): Payload {
	const payload = computerRelease.artifacts.find((item) => item.platform === platform && item.arch === arch);
	if (!payload) throw new Error("Computer use is unsupported on this platform or architecture.");
	return payload;
}

function payloadCache(): string {
	return join(userInfo().homedir, ".lunr", "desktop", "payload");
}

function errorCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	if ("code" in error && typeof error.code === "string") return error.code;
	return errorCode(error.cause);
}

// Cached archives verified in this process, by path, with the size and mtime that were hashed.
const verifiedArchives = new Map<string, string>();

/** The cached archive when it matches the pin. A mismatching file is deleted so it is fetched again. */
async function verifiedCachedArchive(payload: Payload, signal?: AbortSignal): Promise<string | undefined> {
	const cached = join(payloadCache(), payload.name);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(cached);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	const stamp = `${info.size}:${info.mtimeMs}`;
	if (info.isFile() && verifiedArchives.get(cached) === stamp) return cached;
	if (info.isFile() && info.size === payload.bytes && (await digest(cached, signal)) === payload.sha256) {
		verifiedArchives.set(cached, stamp);
		return cached;
	}
	verifiedArchives.delete(cached);
	await rm(cached, { force: true });
	return undefined;
}

/** The registry npm would use for @ashx-j packages: environment, then npm's own config, then npmjs. */
async function configuredRegistry(): Promise<string> {
	const fromEnvironment = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY;
	if (fromEnvironment) return fromEnvironment;
	for (const key of ["@ashx-j:registry", "registry"]) {
		try {
			// One npm start, only before a download. A shell resolves npm.cmd on Windows. Workspace
			// settings inherited from `npm run` or `npx` make `npm config get` refuse to run.
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !/^npm_config_workspaces?$/i.test(name)),
			);
			const { stdout } = await promisify(execCommand)(`npm config get ${key}`, {
				cwd: userInfo().homedir,
				env,
				timeout: 10000,
				windowsHide: true,
			});
			const value = stdout.trim();
			if (/^https?:\/\//.test(value)) return value;
		} catch {
			break;
		}
	}
	return NPMJS;
}

/** A one-sentence reason for a failed download, for the user and the model. */
function downloadFailure(url: string, error: unknown): Error {
	const host = URL.canParse(url) ? new URL(url).host : url;
	let reason: string;
	const code = errorCode(error);
	if (error instanceof Error && error.name === "PinnedSizeError") reason = error.message;
	else if (error instanceof Error && error.name === "HttpStatusError") reason = error.message;
	else if (error instanceof Error && error.name === "TimeoutError") reason = "no data arrived for 60 seconds";
	else if (code === "ENOTFOUND" || code === "EAI_AGAIN") reason = "the registry's address could not be resolved";
	else if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET")
		reason = "the connection was refused or dropped";
	else if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") reason = "the connection timed out";
	else if (error instanceof Error && error.name === "PackageFormatError") reason = error.message;
	else reason = "the network request failed";
	return new Error(
		`Could not download the computer-use runtime from ${host}: ${reason}. Check the network or proxy (HTTPS_PROXY), then try again; the download resumes where it stopped.`,
		{ cause: error },
	);
}

function namedError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

/** Appends the registry tarball to `part`, resuming from its current size with an HTTP range request. */
async function fetchTarball(url: string, part: string, limit: number, options: RuntimeDownload): Promise<void> {
	let offset = 0;
	try {
		offset = (await lstat(part)).size;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	if (offset > limit) {
		await rm(part, { force: true });
		offset = 0;
	}
	const stall = new AbortController();
	let timer = setTimeout(() => stall.abort(namedError("TimeoutError", "stalled")), STALL_MS);
	const signal = AbortSignal.any([stall.signal, ...(options.signal ? [options.signal] : [])]);
	try {
		const response = await fetch(url, { signal, headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
		if (response.status === 416 && offset > 0) {
			// The part may already be complete; extraction and the pinned hash decide.
			await response.body?.cancel();
			return;
		}
		if (response.status === 404)
			throw namedError("HttpStatusError", "this lunR version has no runtime package on that registry (HTTP 404)");
		if (response.status === 401 || response.status === 403)
			throw namedError("HttpStatusError", `the registry refused access (HTTP ${response.status})`);
		if (!response.ok || !response.body)
			throw namedError("HttpStatusError", `the registry answered HTTP ${response.status}`);
		let total = Number(response.headers.get("content-length") ?? Number.NaN);
		if (response.status === 206) {
			const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
			if (!range || Number(range[1]) !== offset) {
				await response.body.cancel();
				await rm(part, { force: true });
				return fetchTarball(url, part, limit, options);
			}
			total = Number(range[2]);
		} else offset = 0;
		if (Number.isFinite(total) && total > limit) {
			await response.body.cancel();
			throw namedError(
				"PinnedSizeError",
				`the server offered ${total} bytes, more than the runtime package can hold`,
			);
		}
		const file = await open(part, offset === 0 ? "w" : "a", 0o600);
		let received = offset;
		try {
			for await (const chunk of response.body) {
				received += chunk.byteLength;
				if (received > limit)
					throw namedError("PinnedSizeError", "the server sent more data than the runtime package can hold");
				await file.write(chunk);
				clearTimeout(timer);
				timer = setTimeout(() => stall.abort(namedError("TimeoutError", "stalled")), STALL_MS);
				options.onProgress?.({ received, total: Number.isFinite(total) ? total : limit });
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		throw stall.signal.aborted ? stall.signal.reason : error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Downloads the host's payload package (`@ashx-j/lunr-computer-<platform>-<arch>` at the lunR
 * version) from the npm-configured registry and caches its archive under ~/.lunr/desktop/payload.
 * npm installs every platform's optional packages from a dependency's shrinkwrap, so the CLI does
 * not depend on them. Only an archive matching the pinned size and SHA-256 is kept. An interrupted
 * download resumes. One process downloads at a time; others wait and use its result.
 */
export async function downloadRuntimeArchive(
	packageDirectory = getPackageDir(),
	platform: string = process.platform,
	arch: string = process.arch,
	options: RuntimeDownload = {},
): Promise<string> {
	const payload = payloadFor(platform, arch);
	const version = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")).version;
	const cache = payloadCache();
	await assertOwnedPath(cache);
	await mkdir(cache, { recursive: true, mode: 0o700 });
	let release: (() => Promise<void>) | undefined;
	while (!release) {
		try {
			release = await lockfile.lock(cache, { retries: 0, stale: STALL_MS });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED") throw error;
			await delay(1000, undefined, { signal: options.signal });
		}
	}
	try {
		const ready = await verifiedCachedArchive(payload, options.signal);
		if (ready) return ready;
		// Leftovers of killed downloads and archives of earlier CuaDriver releases.
		const keep = new Set<string>(computerRelease.artifacts.map((item) => item.name));
		const shortName = payload.packageName.split("/")[1];
		const partName = `${shortName}-${version}.tgz.part`;
		for (const entry of await readdir(cache)) {
			if (entry !== partName && !keep.has(entry)) await rm(join(cache, entry), { recursive: true, force: true });
		}
		const registry = (options.registry ?? (await configuredRegistry())).replace(/\/+$/, "");
		const url = `${registry}/${payload.packageName}/-/${shortName}-${version}.tgz`;
		const part = join(cache, partName);
		const temporary = join(cache, `extract-${randomUUID()}`);
		try {
			await fetchTarball(url, part, payload.bytes + TARBALL_SLACK_BYTES, options);
			await mkdir(temporary, { mode: 0o700 });
			try {
				await exec(tar, ["-xzf", part, "-C", temporary, `package/${payload.name}`], {
					timeout: 30000,
					windowsHide: true,
					signal: options.signal,
				});
			} catch (error) {
				if (options.signal?.aborted) throw error;
				await rm(part, { force: true });
				throw namedError("PackageFormatError", "the downloaded file is not a valid runtime package");
			}
			const archive = join(temporary, "package", payload.name);
			const info = await lstat(archive);
			if (
				!info.isFile() ||
				info.size !== payload.bytes ||
				(await digest(archive, options.signal)) !== payload.sha256
			) {
				await rm(part, { force: true });
				throw namedError("PackageFormatError", "the downloaded runtime does not match the pinned SHA-256");
			}
			const cached = join(cache, payload.name);
			try {
				await rename(archive, cached);
			} catch (error) {
				// Windows refuses to replace a file another process holds open; one that already verifies is fine.
				if (!(await verifiedCachedArchive(payload, options.signal))) throw error;
			}
			await rm(part, { force: true });
			const verified = await verifiedCachedArchive(payload, options.signal);
			if (!verified) throw namedError("PackageFormatError", "the cached runtime could not be verified");
			return verified;
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw downloadFailure(url, error);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	} finally {
		await release();
	}
}

/**
 * Finds the host's runtime archive: beside a standalone executable, in an installed payload
 * package, or downloaded earlier by downloadRuntimeArchive. `verified` means the SHA-256 was
 * already checked in this process.
 */
export async function resolveRuntimeArchive(
	packageDirectory = getPackageDir(),
	platform: string = process.platform,
	arch: string = process.arch,
): Promise<{ archive: string; sha256: string; verified: boolean }> {
	const payload = payloadFor(platform, arch);
	let archive = join(packageDirectory, "native", "computer-use", payload.name);
	try {
		await lstat(archive);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		let manifestPath: string | undefined;
		try {
			manifestPath = createRequire(join(packageDirectory, "package.json")).resolve(
				`${payload.packageName}/package.json`,
			);
		} catch {
			const cached = await verifiedCachedArchive(payload);
			if (cached) return { archive: cached, sha256: payload.sha256, verified: true };
			throw new Error("Computer-use runtime is not downloaded yet. Run /computer setup or call a computer tool.");
		}
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const cli = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
		if (manifest.name !== payload.packageName || manifest.version !== cli.version)
			throw new Error(
				"Computer-use payload package version does not match lunR. Reinstall lunR with optional dependencies enabled.",
			);
		archive = join(dirname(manifestPath), payload.name);
	}
	const info = await lstat(archive);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== payload.bytes)
		throw new Error("Bundled computer-use archive is not a regular file of the pinned size.");
	return { archive, sha256: payload.sha256, verified: false };
}

/** Whether the runtime archive is available without a download. */
export async function runtimeArchiveReady(): Promise<boolean> {
	try {
		await resolveRuntimeArchive();
		return true;
	} catch {
		return false;
	}
}

/** A download shared by every caller in this process; listeners get progress. */
export interface SharedDownload {
	done: Promise<string>;
	progress: DownloadProgress;
	listeners: Set<(progress: DownloadProgress) => void>;
}
let sharedDownload: SharedDownload | undefined;

/**
 * Starts the runtime download, or joins the one already running. It is not bound to any tool
 * call: a call that gives up waiting leaves it running, and the next call finds the result.
 */
export function startRuntimeDownload(): SharedDownload {
	if (sharedDownload) return sharedDownload;
	const payload = payloadFor(process.platform, process.arch);
	const listeners = new Set<(progress: DownloadProgress) => void>();
	const shared: SharedDownload = {
		listeners,
		progress: { received: 0, total: payload.bytes },
		done: downloadRuntimeArchive(undefined, undefined, undefined, {
			onProgress: (progress) => {
				shared.progress = progress;
				for (const listener of listeners) listener(progress);
			},
		}).finally(() => {
			if (sharedDownload === shared) sharedDownload = undefined;
		}),
	};
	// A caller that stopped waiting must not see an unhandled rejection.
	shared.done.catch(() => undefined);
	sharedDownload = shared;
	return shared;
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

/** Extracts and checks the runtime from an archive that is already present; it never downloads. */
export async function installRuntime(signal?: AbortSignal): Promise<{ command: string; app?: string }> {
	signal?.throwIfAborted();
	const platform = `${process.platform}-${process.arch}`;
	const { archive, sha256, verified } = await resolveRuntimeArchive();
	if (process.platform === "win32" && process.env.SESSIONNAME === "Services")
		throw new Error("Computer use requires a logged-in interactive desktop.");
	if (!verified && (await digest(archive, signal)) !== sha256)
		throw new Error(`Computer-use archive ${archive} failed SHA-256 verification.`);
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
