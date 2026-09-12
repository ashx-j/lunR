import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("lunR terminal tab title", () => {
	it("cli.ts sets process.title and OSC 0 to lunr before importing main", () => {
		const src = readFileSync(join(srcDir, "cli.ts"), "utf8");
		const titleIdx = src.indexOf('process.title = "lunr"');
		const oscIdx = src.indexOf("\\x1b]0;lunr\\x07");
		const mainIdx = src.indexOf('import("./main.ts")');
		expect(titleIdx).toBeGreaterThan(-1);
		expect(oscIdx).toBeGreaterThan(-1);
		expect(mainIdx).toBeGreaterThan(titleIdx);
		expect(mainIdx).toBeGreaterThan(oscIdx);
	});

	it("ashxj-spinners does not overwrite the OSC title", () => {
		const src = readFileSync(join(srcDir, "builtin-extensions/ashxj-spinners.ts"), "utf8");
		expect(src).not.toContain('setTitle("ashxj")');
		expect(src).not.toMatch(/setTitle\(/);
	});
});
