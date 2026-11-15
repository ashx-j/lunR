import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claudeCodePlatform,
	extractTarEntry,
	installClaudeCode,
	managedClaudeCodePath,
	removeOldClaudeCodeVersions,
} from "../src/utils/claude-code-release.ts";

/** One ustar entry; tar readers only need name, size, type, and the 512-byte layout. */
function tarEntry(name: string, body: Buffer, type = "0"): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000755\0", 100);
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write(type, 156);
	header.write("ustar\0" + "00", 257);
	return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function tarball(...entries: Buffer[]): Buffer {
	return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

const directories: string[] = [];
function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "lunr-claude-code-release-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Claude Code release", () => {
	it("keeps lunR's binary under the agent directory, apart from other installs", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", "/agent");
		expect(managedClaudeCodePath("linux-x64")).toBe(join("/agent", "claude-code", "2.1.310", "claude"));
		expect(managedClaudeCodePath("win32-x64")).toBe(join("/agent", "claude-code", "2.1.310", "claude.exe"));
		vi.unstubAllEnvs();
	});

	it.skipIf(!claudeCodePlatform() || process.platform === "win32")(
		"removes versions left by a pin bump once the pinned one is in use",
		async () => {
			const platform = claudeCodePlatform();
			if (!platform) return;
			const profile = temporaryDirectory();
			vi.stubEnv("PI_CODING_AGENT_DIR", profile);
			const pinned = managedClaudeCodePath(platform);
			const root = join(profile, "claude-code");
			// 2.1.263 is older than the pin, 9.0.0 belongs to a newer lunR, 2.1.100 is being downloaded.
			for (const version of ["2.1.263", "2.1.310", "9.0.0", "2.1.100"]) {
				mkdirSync(join(root, version), { recursive: true });
				writeFileSync(join(root, version, "claude"), "");
			}
			writeFileSync(join(root, "2.1.100", `claude.${process.pid}.id.download`), "");
			mkdirSync(join(root, "notes"));
			const shared = temporaryDirectory();
			mkdirSync(join(shared, "2.1.200"));
			symlinkSync(join(shared, "2.1.200"), join(root, "2.1.200"));

			// A connection still on the old version keeps every version.
			expect(await removeOldClaudeCodeVersions(join(root, "2.1.263", "claude"))).toEqual([]);
			expect(await removeOldClaudeCodeVersions(pinned)).toEqual(["2.1.263"]);
			expect(readdirSync(root).sort()).toEqual(["2.1.100", "2.1.200", "2.1.310", "9.0.0", "notes"]);
			expect(existsSync(join(shared, "2.1.200"))).toBe(true);

			// A claude-code folder that links elsewhere is shared, so nothing in it is removed.
			const linked = temporaryDirectory();
			vi.stubEnv("PI_CODING_AGENT_DIR", linked);
			mkdirSync(join(shared, "2.1.263"));
			symlinkSync(shared, join(linked, "claude-code"));
			expect(await removeOldClaudeCodeVersions(managedClaudeCodePath(platform))).toEqual([]);
			expect(existsSync(join(shared, "2.1.263"))).toBe(true);
			vi.unstubAllEnvs();
		},
	);

	it("extracts only the requested file, following pax names across small chunks", async () => {
		const binary = Buffer.alloc(1500, 7);
		const archive = tarball(
			tarEntry("package/README.md", Buffer.from("readme")),
			tarEntry("PaxHeader", Buffer.from("28 path=package/claude-long\n"), "x"),
			tarEntry("package/ignored-short-name", binary),
			tarEntry("package/claude", Buffer.from("wrong file")),
		);
		const chunks = async function* () {
			for (let offset = 0; offset < archive.length; offset += 97) yield archive.subarray(offset, offset + 97);
		};
		const target = join(temporaryDirectory(), "claude");
		expect(await extractTarEntry(chunks(), "package/claude-long", target)).toBe(true);
		expect(readFileSync(target)).toEqual(binary);
	});

	it("installs nothing when the download does not match the pinned integrity", async () => {
		const archive = gzipSync(tarball(tarEntry("package/claude", Buffer.from("not claude"))));
		vi.stubGlobal("fetch", async () => new Response(archive, { status: 200 }));
		const directory = temporaryDirectory();
		const target = join(directory, "claude");
		await expect(installClaudeCode("linux-x64", target)).rejects.toThrow("pinned npm integrity");
		expect(existsSync(target)).toBe(false);
		expect(readdirSync(directory)).toEqual([]);
	});

	it("fails with a stall error and leaves no temporary file when the connection goes silent mid-download", async () => {
		// Send roughly half of a valid archive, then stop writing without closing the connection.
		const archive = gzipSync(tarball(tarEntry("package/claude", randomBytes(256 * 1024))));
		const server = createServer((_request, response) => {
			response.writeHead(200);
			response.write(archive.subarray(0, archive.length / 2));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("server did not bind a port");
			const realFetch = fetch;
			vi.stubGlobal("fetch", (_url: string, init?: RequestInit) =>
				realFetch(`http://127.0.0.1:${address.port}/claude.tgz`, init),
			);
			const directory = temporaryDirectory();
			const target = join(directory, "claude");
			await expect(installClaudeCode("linux-x64", target, { stallTimeoutMs: 300 })).rejects.toThrow("stalled");
			expect(existsSync(target)).toBe(false);
			expect(readdirSync(directory)).toEqual([]);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
