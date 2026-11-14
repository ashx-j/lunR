import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPipedStdin } from "../src/cli/piped-stdin.ts";
import { getExtensionAliasesForTest } from "../src/core/extensions/loader.ts";
import { showDeprecationWarnings } from "../src/migrations.ts";

class FakeStdin extends EventEmitter {
	isTTY = false;
	readable = true;
	setEncoding(): this {
		return this;
	}
	resume(): this {
		return this;
	}
	pause(): this {
		return this;
	}
	off(event: string | symbol, listener: (...args: unknown[]) => void): this {
		return super.off(event, listener);
	}
}

describe("startup hang follow-ups", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("readPipedStdin gives up and pauses stdin when no first byte arrives", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const stream = new FakeStdin();
		const pause = vi.spyOn(stream, "pause");
		const read = readPipedStdin(stream as unknown as NodeJS.ReadStream, { firstByteMs: 20, silenceMs: 1000 });
		await expect(read).resolves.toBeUndefined();
		expect(pause).toHaveBeenCalled();
	});

	it("readPipedStdin waits past the first-byte bound once a producer has started", async () => {
		const stream = new FakeStdin();
		const read = readPipedStdin(stream as unknown as NodeJS.ReadStream, { firstByteMs: 100, silenceMs: 300 });
		setTimeout(() => stream.emit("data", "late "), 50);
		setTimeout(() => stream.emit("data", "input"), 250);
		setTimeout(() => stream.emit("end"), 450);
		await expect(read).resolves.toBe("late input");
	});

	it("showDeprecationWarnings does not wait for a key when stdin is not a TTY", async () => {
		const original = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
		const once = vi.spyOn(process.stdin, "once");
		try {
			const started = Date.now();
			await showDeprecationWarnings(["hooks/ is deprecated"]);
			expect(Date.now() - started).toBeLessThan(500);
			expect(once).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: original });
		}
	});

	it("registers both @earendil-works and @ashx-j extension aliases", () => {
		const aliases = getExtensionAliasesForTest();
		expect(aliases["@earendil-works/pi-coding-agent"]).toBeDefined();
		expect(aliases["@ashx-j/lunr"]).toBe(aliases["@earendil-works/pi-coding-agent"]);
		expect(aliases["@ashx-j/lunr-ai"]).toBe(aliases["@earendil-works/pi-ai"]);
		expect(aliases["@ashx-j/lunr-tui"]).toBe(aliases["@earendil-works/pi-tui"]);
		expect(aliases["@ashx-j/lunr-agent"]).toBe(aliases["@earendil-works/pi-agent-core"]);
	});
});
