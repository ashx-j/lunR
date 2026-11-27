import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertOwnedPath,
	downloadRuntimeArchive,
	installRuntime,
	resolveRuntimeArchive,
} from "../src/core/computer-use/runtime.ts";

const state = vi.hoisted(() => ({
	root: "",
	archive: undefined as { bytes: number; sha256: string } | undefined,
	target: undefined as { platform: string; arch: string } | undefined,
}));
vi.mock("../src/core/computer-use/release.generated.ts", async (original) => {
	const { computerRelease } = await original<typeof import("../src/core/computer-use/release.generated.ts")>();
	return {
		computerRelease: {
			...computerRelease,
			get artifacts() {
				return computerRelease.artifacts.map((artifact) =>
					artifact.platform === (state.target?.platform ?? process.platform) &&
					artifact.arch === (state.target?.arch ?? process.arch) &&
					state.archive
						? { ...artifact, ...state.archive }
						: artifact,
				);
			},
		},
	};
});
vi.mock("node:os", async (original) => {
	const os = await original<typeof import("node:os")>();
	return {
		...os,
		userInfo: () => {
			if (!state.root) throw new Error("Test home not configured.");
			return { ...os.userInfo(), homedir: state.root };
		},
	};
});
afterEach(async () => {
	vi.unstubAllEnvs();
	if (state.root) await rm(state.root, { recursive: true, force: true });
	state.root = "";
	state.archive = undefined;
	state.target = undefined;
});

/**
 * A registry serving one win32-x64 payload tarball that wraps `bytes`, pinned in the mocked
 * release. `handler` replaces the default full response.
 */
async function registryFixture(
	bytes: Buffer,
	handler?: (request: IncomingMessage, response: ServerResponse, tarball: Buffer) => void,
) {
	state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
	state.target = { platform: "win32", arch: "x64" };
	state.archive = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
	const { computerRelease } = await import("../src/core/computer-use/release.generated.ts");
	const name = computerRelease.artifacts.find((item) => item.platform === "win32" && item.arch === "x64")?.name;
	if (!name) throw new Error("No win32/x64 metadata.");
	const packed = join(state.root, "packed");
	await mkdir(join(packed, "package"), { recursive: true });
	await writeFile(join(packed, "package", name), bytes);
	// Relative paths: the GNU tar on a Windows runner's PATH reads `D:` in an absolute path as a remote host.
	execFileSync("tar", ["-czf", "payload.tgz", "package"], { cwd: packed });
	const tarball = await readFile(join(packed, "payload.tgz"));
	await writeFile(join(state.root, "package.json"), JSON.stringify({ version: "0.9.0" }));
	const requests: Array<{ url: string; range?: string }> = [];
	const server = createServer((request, response) => {
		requests.push({ url: request.url ?? "", range: request.headers.range });
		if (handler) handler(request, response, tarball);
		else response.end(tarball);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test registry port.");
	return {
		bytes,
		name,
		requests,
		registry: `http://127.0.0.1:${address.port}/`,
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

describe("verified native installation", () => {
	it("reports unsupported hosts, a runtime not downloaded yet, and mismatched package versions", async () => {
		state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
		await writeFile(join(state.root, "package.json"), JSON.stringify({ version: "0.9.0" }));
		await expect(resolveRuntimeArchive(state.root, "linux", "x64")).rejects.toThrow("unsupported");
		await expect(resolveRuntimeArchive(state.root, "win32", "x64")).rejects.toThrow("not downloaded yet");
		const payload = join(state.root, "node_modules", "@ashx-j", "lunr-computer-win32-x64");
		await mkdir(payload, { recursive: true });
		await writeFile(
			join(payload, "package.json"),
			JSON.stringify({ name: "@ashx-j/lunr-computer-win32-x64", version: "0.9.0-other" }),
		);
		await expect(resolveRuntimeArchive(state.root, "win32", "x64")).rejects.toThrow("version does not match");
	});
	it("downloads the host payload once, keeps it only when it matches the pin, and refetches a corrupt cache", async () => {
		const f = await registryFixture(Buffer.from("pinned archive fixture"));
		try {
			const pin = state.archive;
			state.archive = { bytes: f.bytes.length, sha256: "0".repeat(64) };
			await expect(downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry })).rejects.toThrow(
				/^Could not download the computer-use runtime from 127\.0\.0\.1:\d+: the downloaded runtime does not match the pinned SHA-256\./,
			);
			state.archive = pin;
			const archive = await downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry });
			expect(archive).toBe(join(state.root, ".lunr", "desktop", "payload", f.name));
			expect(await resolveRuntimeArchive(state.root, "win32", "x64")).toEqual({
				archive,
				sha256: pin?.sha256,
				verified: true,
			});
			expect(await downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry })).toBe(archive);
			expect(f.requests).toHaveLength(2);
			const corrupt = Buffer.from(f.bytes);
			corrupt[0] ^= 1;
			await writeFile(archive, corrupt);
			await expect(resolveRuntimeArchive(state.root, "win32", "x64")).rejects.toThrow("not downloaded yet");
			await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" });
			expect(
				await readFile(await downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry })),
			).toEqual(f.bytes);
			expect(f.requests.map((request) => request.url)).toEqual(
				Array(3).fill("/@ashx-j/lunr-computer-win32-x64/-/lunr-computer-win32-x64-0.9.0.tgz"),
			);
		} finally {
			await f.close();
		}
	});
	it("resumes an interrupted download with a range request and explains the failure in one sentence", async () => {
		const f = await registryFixture(randomBytes(300_000), (request, response, tarball) => {
			const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
			if (!range) {
				response.writeHead(200, { "content-length": tarball.length });
				// Pause first: a stream that errors drops chunks the reader has not taken yet.
				response.write(tarball.subarray(0, 100_000), () => setTimeout(() => response.destroy(), 300));
				return;
			}
			const start = Number(range[1]);
			response.writeHead(206, {
				"content-length": tarball.length - start,
				"content-range": `bytes ${start}-${tarball.length - 1}/${tarball.length}`,
			});
			response.end(tarball.subarray(start));
		});
		try {
			const progress: number[] = [];
			await expect(
				downloadRuntimeArchive(state.root, "win32", "x64", {
					registry: f.registry,
					onProgress: ({ received }) => progress.push(received),
				}),
			).rejects.toThrow(
				/^Could not download the computer-use runtime from 127\.0\.0\.1:\d+: the connection was refused or dropped\. Check the network or proxy/,
			);
			const archive = await downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry });
			expect(await readFile(archive)).toEqual(f.bytes);
			const resumed = Number(/^bytes=(\d+)-$/.exec(f.requests[1]?.range ?? "")?.[1]);
			expect(resumed).toBeGreaterThan(0);
			expect(resumed).toBe(progress.at(-1));
		} finally {
			await f.close();
		}
	});
	it("stops at the size the runtime package can hold", async () => {
		let declared = true;
		const f = await registryFixture(Buffer.from("small archive"), (_request, response) => {
			if (declared) {
				response.writeHead(200, { "content-length": 10_000_000 });
				response.end();
				return;
			}
			response.writeHead(200);
			const chunk = Buffer.alloc(16_384);
			const pump = () => {
				while (!response.destroyed && response.write(chunk));
				if (!response.destroyed) response.once("drain", pump);
			};
			pump();
		});
		try {
			await expect(downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry })).rejects.toThrow(
				"offered 10000000 bytes, more than the runtime package can hold",
			);
			declared = false;
			await expect(downloadRuntimeArchive(state.root, "win32", "x64", { registry: f.registry })).rejects.toThrow(
				"sent more data than the runtime package can hold",
			);
			const part = join(state.root, ".lunr", "desktop", "payload", "lunr-computer-win32-x64-0.9.0.tgz.part");
			expect((await stat(part)).size).toBeLessThanOrEqual(f.bytes.length + 64 * 1024);
		} finally {
			await f.close();
		}
	});
	it("uses the npm-configured registry and lets concurrent downloads share one request", async () => {
		const f = await registryFixture(Buffer.from("shared archive"));
		vi.stubEnv("npm_config_registry", f.registry);
		try {
			const archives = await Promise.all([1, 2, 3].map(() => downloadRuntimeArchive(state.root, "win32", "x64")));
			expect(new Set(archives).size).toBe(1);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.close();
		}
	});
	it.skipIf(process.platform !== "win32")(
		"serializes extraction and rejects tampered cached helpers without overwriting them",
		async () => {
			state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
			const { computerRelease } = await import("../src/core/computer-use/release.generated.ts");
			const artifact = computerRelease.artifacts.find(
				(item) => item.platform === process.platform && item.arch === process.arch,
			);
			if (!artifact) throw new Error("No host fixture metadata.");
			const source = join(state.root, "source");
			const packageRoot = join(state.root, "package");
			const payload = join(packageRoot, "native", "computer-use");
			await mkdir(source);
			await mkdir(payload, { recursive: true });
			await writeFile(join(source, "cua-driver.exe"), "inert driver fixture");
			await writeFile(join(source, "cua-driver-uia.exe"), "inert helper fixture");
			const archive = join(payload, artifact.name);
			execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), [
				"-a",
				"-cf",
				archive,
				"-C",
				source,
				"cua-driver.exe",
				"cua-driver-uia.exe",
			]);
			const bytes = await readFile(archive);
			state.archive = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
			vi.stubEnv("PI_PACKAGE_DIR", packageRoot);
			vi.stubEnv("SESSIONNAME", "Console");
			const results = await Promise.allSettled([installRuntime(), installRuntime()]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
				results.map((result) => (result.status === "rejected" ? String(result.reason) : "installed")).join("; "),
			).toHaveLength(1);
			const installed = results.find((result) => result.status === "fulfilled");
			if (installed?.status !== "fulfilled") throw new Error("No installation completed.");
			expect(installed.value.command.startsWith(state.root)).toBe(true);
			expect(await installRuntime()).toEqual(installed.value);
			const helper = join(state.root, ".lunr", "desktop", `runtime-win32-${process.arch}`, "cua-driver-uia.exe");
			await writeFile(helper, "tampered helper");
			await expect(installRuntime()).rejects.toThrow("differs from the verified archive");
			expect(await readFile(helper, "utf8")).toBe("tampered helper");
		},
		60000,
	);
	it("rejects a redirected runtime directory", async () => {
		state.root = await mkdtemp(join(tmpdir(), "lunr-install-test-"));
		const link = join(state.root, "redirect");
		await symlink(state.root, link, process.platform === "win32" ? "junction" : "dir");
		await expect(assertOwnedPath(link)).rejects.toThrow("redirects elsewhere");
	});
});
