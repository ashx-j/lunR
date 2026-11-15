import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("lunR terminal tab title", () => {
	it("CLI runtime sets the stable or dev title before importing main", () => {
		const src = readFileSync(join(srcDir, "cli-runtime.ts"), "utf8");
		const titleIdx = src.indexOf('process.title = isDevChannel ? "lunr-dev" : "lunr"');
		const oscIdx = src.indexOf("\\x1b]0;lunr-dev\\x07");
		const mainIdx = src.indexOf('import("./main.ts")');
		expect(src).toContain('? "lunr-dev" : "lunr"');
		expect(titleIdx).toBeGreaterThan(-1);
		expect(oscIdx).toBeGreaterThan(-1);
		expect(mainIdx).toBeGreaterThan(titleIdx);
		expect(mainIdx).toBeGreaterThan(oscIdx);
	});

	it("dev-cli.ts selects the dev startup identity", () => {
		const src = readFileSync(join(srcDir, "dev-cli.ts"), "utf8");
		expect(src).toContain('process.env.PI_CODING_AGENT_DEV = "1"');
		expect(src).toContain('import("./cli.ts")');
	});

	it("pushes the previous title before the first write and pops it in the exit handler", () => {
		const src = readFileSync(join(srcDir, "cli-runtime.ts"), "utf8");
		const pushIdx = src.indexOf("\\x1b[22;0t\\x1b]0;lunr\\x07");
		const exitIdx = src.indexOf('process.once("exit"');
		const popIdx = src.indexOf("\\x1b[23;0t");
		expect(pushIdx).toBeGreaterThan(-1);
		expect(exitIdx).toBeGreaterThan(pushIdx);
		expect(popIdx).toBeGreaterThan(exitIdx);
	});

	it("ashxj-spinners does not overwrite the OSC title", () => {
		const src = readFileSync(join(srcDir, "builtin-extensions/ashxj-spinners.ts"), "utf8");
		expect(src).not.toContain('setTitle("ashxj")');
		expect(src).not.toMatch(/setTitle\(/);
	});
});
