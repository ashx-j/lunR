import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { rewritePackageJsonForNpm } from "../../../scripts/lunr-npm-names.mjs";

it("ships a name-independent lifecycle script and installs through npm unless scripts/offline mode skip it", () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-install-"));
	try {
		const source = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
		const published = rewritePackageJsonForNpm(source);
		expect(published.name).toBe("@ashx-j/lunr");
		expect(published.scripts.postinstall).toBe("node scripts/install-browser.mjs");
		expect(published.files).toContain("scripts/install-browser.mjs");
		mkdirSync(join(dir, "scripts"));
		mkdirSync(join(dir, "core"));
		copyFileSync(resolve("scripts/install-browser.mjs"), join(dir, "scripts/install-browser.mjs"));
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: published.name,
				version: source.version,
				scripts: { postinstall: published.scripts.postinstall },
				dependencies: { "playwright-core": "file:./core" },
			}),
		);
		writeFileSync(
			join(dir, "core/package.json"),
			JSON.stringify({ name: "playwright-core", version: "1.0.0", exports: { "./package.json": "./package.json" } }),
		);
		writeFileSync(
			join(dir, "core/cli.js"),
			'require("node:fs").writeFileSync(process.env.BROWSER_INSTALL_MARKER, process.argv.slice(2).join(" "));',
		);
		const marker = join(dir, "installed");
		const env = {
			...process.env,
			BROWSER_INSTALL_MARKER: marker,
			PI_OFFLINE: "0",
			PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "0",
			npm_config_offline: "false",
			npm_config_package_lock_only: "false",
		};
		const install = (flags: string[]) => {
			const result = spawnSync(
				process.platform === "win32" ? "npm.cmd" : "npm",
				["install", "--no-audit", "--no-fund", ...flags],
				{ cwd: dir, env, encoding: "utf8", shell: process.platform === "win32", timeout: 30000 },
			);
			expect(result.status, result.stderr + result.stdout).toBe(0);
		};
		install(["--ignore-scripts"]);
		expect(existsSync(marker)).toBe(false);
		install(["--offline"]);
		expect(existsSync(marker)).toBe(false);
		install([]);
		expect(readFileSync(marker, "utf8")).toBe("install chromium");
		rmSync(marker);
		const skipped = spawnSync(process.execPath, [join(dir, "scripts/install-browser.mjs")], {
			env: { ...env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
			encoding: "utf8",
		});
		expect(skipped.status).toBe(0);
		expect(existsSync(marker)).toBe(false);
		writeFileSync(join(dir, "node_modules/playwright-core/cli.js"), "process.exit(42);");
		const failed = spawnSync(process.execPath, [join(dir, "scripts/install-browser.mjs")], { env, encoding: "utf8" });
		expect(failed.status).toBe(0);
		expect(failed.stderr).toContain("lunr browser install");
		const explicit = spawnSync(process.execPath, [join(dir, "scripts/install-browser.mjs"), "--explicit"], {
			env,
			encoding: "utf8",
		});
		expect(explicit.status).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 60000);
