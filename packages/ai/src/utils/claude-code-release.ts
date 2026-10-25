import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { arch, homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { CLAUDE_CODE_VERSION } from "../auth/anthropic-route.ts";

export { CLAUDE_CODE_VERSION };

/** npm registry integrity of each `@anthropic-ai/claude-code-<platform>` tarball for `CLAUDE_CODE_VERSION`. */
const PLATFORM_INTEGRITY = {
	"darwin-arm64": "sha512-1HkmRv3tvMTjTrsW5J17S3NtjFjEDC8nnhduNT0klPStHes8/FRX1YFv7UwnfC6fuwd31kFuzWLyNn2IN07JtQ==",
	"darwin-x64": "sha512-7httDzvIQv+LZF7cSdTu6/hCeOVEbUKmeQ1D1yv0OV1cWH6yjthUucbSFmQKKCUjXmKyI2iomunw+W9Rvbyo5g==",
	"linux-x64": "sha512-CuzpJrMBbqaR3+1SiLrBtPV3w/cFvcqBfhe9kNskzZ2Fm6KXa7v0l7tM+Ln6l5QLb79WoU0CcacXnYtsygbe6A==",
	"linux-arm64": "sha512-iAukGiGmsInasuW34o4ExD8Gqh3b/CPUp6kjxsWIBT8tFBrVFxtWGfI7wfRy3owWrbuRekBCaHQFMiI2ddWUpA==",
	"linux-x64-musl": "sha512-NuXHtNyJMa59njKJBHSIY8oVxDYydVaWsa+Ij7VV0bLMSjWjK2L76WG6OhQmJjwGqjOVKd542DhPVDsrX+iB+g==",
	"linux-arm64-musl":
		"sha512-w0h8eJdDUmnCAtMSthCBC8AeB0nmnBhueVD9XPyPOxC8Sf+4zLy6k0hbAC+StonX80M0f7YVzHaQ9VXtNSxlWQ==",
	"win32-x64": "sha512-h1whtXm0n7w9qxgsEP/2Yowamvg2YfzrVHgks8PR+JYacDtRLl8pmUg2vi0h4ZJN86OHpiqvAx0+y9mSdtUhIQ==",
	"win32-arm64": "sha512-+x+xufRD/H36EKf9ycbYAnfhETNPXdzSD8jUA4iMPpB6k/vzWqisa5gy+z7Y4Z1bE3SUpIMB5pD3xjipIMnr+g==",
} as const;

export type ClaudeCodePlatform = keyof typeof PLATFORM_INTEGRITY;

function isClaudeCodePlatform(value: string): value is ClaudeCodePlatform {
	return Object.hasOwn(PLATFORM_INTEGRITY, value);
}

/** Native package key for this machine, matching Claude Code's own installer. Undefined when unsupported. */
export function claudeCodePlatform(): ClaudeCodePlatform | undefined {
	let key = `${process.platform}-${arch()}`;
	if (process.platform === "linux") {
		// Node's diagnostic report omits glibcVersionRuntime on musl systems.
		const report = process.report?.getReport();
		const header = report && "header" in report && typeof report.header === "object" ? report.header : undefined;
		if (!header || !("glibcVersionRuntime" in header)) key += "-musl";
	}
	return isClaudeCodePlatform(key) ? key : undefined;
}

function binaryName(platform: ClaudeCodePlatform): string {
	return platform.startsWith("win32") ? "claude.exe" : "claude";
}

/**
 * Absolute path of lunR's own Claude Code binary. It lives under the agent directory, apart from any
 * Claude Code the user installed, so updates elsewhere never change the version lunR runs.
 */
export function managedClaudeCodePath(platform: ClaudeCodePlatform): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".lunr", "agent");
	return join(agentDir, "claude-code", CLAUDE_CODE_VERSION, binaryName(platform));
}

/** Copies one regular file out of a tar stream into `target`; every other entry is read and discarded. Exported for tests. */
export async function extractTarEntry(
	source: AsyncIterable<Buffer>,
	entryName: string,
	target: string,
): Promise<boolean> {
	let pending: Buffer = Buffer.alloc(0);
	// Bytes left in the current entry body, then the zero padding up to the next 512-byte block.
	let remaining = 0;
	let padding = 0;
	let sink: "skip" | "pax" | "file" = "skip";
	let pax: Buffer[] = [];
	let paxPath: string | undefined;
	let output: WriteStream | undefined;
	// Disk errors (ENOSPC, EACCES) surface here instead of as an unhandled stream event.
	let writeError: Error | undefined;
	let found = false;
	let ended = false;

	const finishEntry = async () => {
		if (sink === "file" && output) {
			output.end();
			await finished(output);
			output = undefined;
		}
		// A pax header's `path` record replaces the name of the entry that follows it.
		if (sink === "pax") paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(pax).toString("utf8"))?.[1];
		sink = "skip";
	};

	try {
		for await (const chunk of source) {
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			while (pending.length) {
				if (remaining > 0) {
					const body = pending.subarray(0, Math.min(remaining, pending.length));
					pending = pending.subarray(body.length);
					remaining -= body.length;
					if (sink === "file" && output && !output.write(body)) {
						const stream = output;
						await new Promise<void>((resolve, reject) => {
							if (writeError) return reject(writeError);
							stream.once("drain", resolve);
							stream.once("error", reject);
						});
					} else if (sink === "pax") pax.push(body);
					if (writeError) throw writeError;
					if (remaining === 0) await finishEntry();
					continue;
				}
				if (padding > 0) {
					const skipped = Math.min(padding, pending.length);
					pending = pending.subarray(skipped);
					padding -= skipped;
					continue;
				}
				// Read the rest of the stream after the end marker so the integrity hash covers every byte.
				if (ended) pending = Buffer.alloc(0);
				if (ended || pending.length < 512) break;
				const header = pending.subarray(0, 512);
				pending = pending.subarray(512);
				if (header.every((byte) => byte === 0)) {
					ended = true;
					continue;
				}
				const field = (start: number, length: number) =>
					header
						.subarray(start, start + length)
						.toString("utf8")
						.replace(/\0[\s\S]*$/, "");
				remaining = Number.parseInt(field(124, 12).trim() || "0", 8);
				if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid Claude Code archive");
				padding = (512 - (remaining % 512)) % 512;
				const type = field(156, 1);
				const prefix = field(345, 155);
				const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
				paxPath = undefined;
				if (type === "x") {
					sink = "pax";
					pax = [];
				} else if ((type === "0" || type === "") && name === entryName) {
					sink = "file";
					found = true;
					output = createWriteStream(target, { mode: 0o755 });
					output.on("error", (error) => {
						writeError = error;
					});
				}
				if (remaining === 0) await finishEntry();
			}
		}
	} finally {
		// Wait for the descriptor to close so the caller can delete the file on Windows.
		if (output) {
			output.destroy();
			await finished(output).catch(() => {});
		}
	}
	return found;
}

/** The download is aborted when no bytes arrive for this long. */
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;

/**
 * Downloads the pinned Claude Code binary for `platform` from the npm registry into `target`. The
 * tarball must match the pinned registry integrity before the binary moves into place. A connection
 * that sends nothing for `stallTimeoutMs` fails with a "stalled" error instead of hanging.
 */
export async function installClaudeCode(
	platform: ClaudeCodePlatform,
	target: string,
	options: {
		signal?: AbortSignal;
		stallTimeoutMs?: number;
		onProgress?: (received: number, total: number | undefined) => void;
	} = {},
): Promise<void> {
	const url = `https://registry.npmjs.org/@anthropic-ai/claude-code-${platform}/-/claude-code-${platform}-${CLAUDE_CODE_VERSION}.tgz`;
	const stallTimeoutMs = options.stallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;
	const stall = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal;
	let stalled = false;
	let stallTimer: NodeJS.Timeout | undefined;
	// Restarted on every received chunk; also covers the wait for response headers.
	const armStallTimer = () => {
		clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			stalled = true;
			stall.abort();
		}, stallTimeoutMs);
	};
	const temporary = `${target}.${process.pid}.${randomUUID()}.download`;
	const hash = createHash("sha512");
	let received = 0;
	let found = false;
	armStallTimer();
	try {
		const response = await fetch(url, { signal });
		if (!response.ok || !response.body) throw new Error(`Claude Code download failed with HTTP ${response.status}`);
		const total = Number(response.headers.get("content-length")) || undefined;
		await mkdir(dirname(target), { recursive: true });
		await pipeline(
			Readable.fromWeb(response.body),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					armStallTimer();
					hash.update(chunk);
					received += chunk.length;
					options.onProgress?.(received, total);
					callback(null, chunk);
				},
			}),
			createGunzip(),
			async (source: AsyncIterable<Buffer>) => {
				found = await extractTarEntry(source, `package/${binaryName(platform)}`, temporary);
			},
			{ signal },
		);
		if (`sha512-${hash.digest("base64")}` !== PLATFORM_INTEGRITY[platform])
			throw new Error("Claude Code download does not match the pinned npm integrity. Nothing was installed.");
		if (!found) throw new Error("Claude Code download did not contain the expected binary");
		await rename(temporary, target);
	} catch (error) {
		if (stalled && !options.signal?.aborted)
			throw new Error(
				`Claude Code download stalled: no data for ${Math.round(stallTimeoutMs / 1000)} seconds. Check the connection and retry.`,
			);
		throw error;
	} finally {
		clearTimeout(stallTimer);
		// A cleanup failure must not hide the download error.
		await rm(temporary, { force: true }).catch(() => {});
	}
}
