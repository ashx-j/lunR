import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../src");

describe("lunR terminal tab title", () => {
	it("cli.ts sets the stable or dev title before importing main", () => {
		const src = readFileSync(join(srcDir, "cli.ts"), "utf8");
		const titleIdx = src.indexOf("process.title = startupAppName");
		const oscIdx = src.indexOf("process.stdout.write(`\\x1b]0;");
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

	it("ashxj-spinners does not overwrite the OSC title", () => {
		const src = readFileSync(join(srcDir, "builtin-extensions/ashxj-spinners.ts"), "utf8");
		expect(src).not.toContain('setTitle("ashxj")');
		expect(src).not.toMatch(/setTitle\(/);
	});
});
