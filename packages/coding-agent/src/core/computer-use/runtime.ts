import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { getPackageDir } from "../../config.ts";

import { computerRelease } from "./release.generated.ts";

const exec = promisify(execFile);
export const CUA_VERSION = computerRelease.version;

export async function resolveRuntimeArchive(
	packageDirectory = getPackageDir(),
	platform: string = process.platform,
	arch: string = process.arch,
): Promise<{ archive: string; sha256: string }> {
	const payload = computerRelease.artifacts.find((item) => item.platform === platform && item.arch === arch);
	if (!payload) throw new Error("Computer use is unsupported on this platform or architecture.");
	let archive = join(packageDirectory, "native", "computer-use", payload.name);
	try {
		await lstat(archive);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		let manifestPath: string;
		try {
			manifestPath = createRequire(join(packageDirectory, "package.json")).resolve(
				`${payload.packageName}/package.json`,
			);
		} catch {
			throw new Error(
				"Computer-use payload is missing. Reinstall lunR with optional dependencies enabled. No runtime was downloaded.",
			);
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

export async function installRuntime(signal?: AbortSignal): Promise<{ command: string; app?: string }> {
	signal?.throwIfAborted();
	const platform = `${process.platform}-${process.arch}`;
	const { archive, sha256 } = await resolveRuntimeArchive();
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
		await exec(
			process.platform === "win32"
				? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
				: "/usr/bin/tar",
			["-xf", archive, "-C", temporary],
			{
				timeout: 30000,
				windowsHide: true,
				signal,
			},
		);
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
