import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("RPC package entry", () => {
	it("exports a wrapper that falls back to the unbundled RPC entry", () => {
		const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		expect(pkg.exports["./rpc-entry"].import).toBe("./dist/rpc.js");
		expect(existsSync(join(packageRoot, "src", "rpc.ts"))).toBe(true);
		const source = readFileSync(join(packageRoot, "src", "rpc.ts"), "utf8");
		expect(source).toContain("./node-runtime/rpc-entry.js");
		expect(source).toContain("./rpc-entry.ts");
	});

	it("runs the compiled fallback and prefers the bundle when present", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-rpc-entry-"));
		try {
			writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
			copyFileSync(join(packageRoot, "dist", "rpc.js"), join(root, "rpc.js"));
			writeFileSync(join(root, "rpc-entry.js"), 'process.stdout.write("fallback");\n');
			const fallback = spawnSync(process.execPath, [join(root, "rpc.js")], { encoding: "utf8" });
			expect(fallback.status).toBe(0);
			expect(fallback.stdout).toBe("fallback");

			mkdirSync(join(root, "node-runtime"));
			writeFileSync(join(root, "node-runtime", "rpc-entry.js"), 'process.stdout.write("bundle");\n');
			const bundled = spawnSync(process.execPath, [join(root, "rpc.js")], { encoding: "utf8" });
			expect(bundled.status).toBe(0);
			expect(bundled.stdout).toBe("bundle");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
