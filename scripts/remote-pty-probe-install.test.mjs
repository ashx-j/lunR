import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isolatedNpmEnvironment } from "./remote-pty-probe-install.mjs";

test("isolated npm keeps a Windows system shell for lifecycle scripts", async () => {
	const profile = mkdtempSync(join(tmpdir(), "lunr-npm-profile-"));
	try {
		const env = await isolatedNpmEnvironment(profile);
		assert.equal(env.HOME, profile);
		assert.equal(env.npm_config_userconfig, join(profile, "npmrc"));
		if (process.platform === "win32") {
			assert.equal(env.ComSpec.toLowerCase(), join(process.env.SystemRoot, "System32", "cmd.exe").toLowerCase());
			assert.ok(existsSync(env.ComSpec));
		} else {
			assert.equal(Object.hasOwn(env, "ComSpec"), false);
		}
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});
