import { globalBridge } from "./global-bridge.ts";

interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

// The CLI runs from a bundle, while built-in extensions import this file unbundled. Both copies
// keep the takeover and the raw write queue on globalThis, so an extension's writeRawStdout()
// reaches real stdout after the CLI took it over.
const takeoverSlot = globalBridge<StdoutTakeoverState>(Symbol.for("@lunr/stdout-takeover"));
const writeTailSlot = globalBridge<Promise<void>>(Symbol.for("@lunr/raw-stdout-write-tail"));

const RAW_STDOUT_RETRY_DELAY_MS = 10;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	const takeover = takeoverSlot.get();
	if (takeover) {
		return takeover.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (takeoverSlot.get()) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	takeoverSlot.set({
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	});
}

export function restoreStdout(): void {
	const takeover = takeoverSlot.get();
	if (!takeover) {
		return;
	}

	process.stdout.write = takeover.originalStdoutWrite;
	takeoverSlot.set(undefined);
}

export function isStdoutTakenOver(): boolean {
	return takeoverSlot.get() !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	const tail = (writeTailSlot.get() ?? Promise.resolve()).then(() => writeRawStdoutChunk(text));
	writeTailSlot.set(tail);
	void tail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = writeTailSlot.get() ?? Promise.resolve();
		await tail;
		if (tail === (writeTailSlot.get() ?? tail)) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
