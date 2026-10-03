import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const runner = fileURLToPath(new URL("../../../test.sh", import.meta.url));

for (const exitCode of [0, 23]) {
	for (const withAuth of [true, false]) {
		test(`isolates tests and preserves saved profiles on exit ${exitCode}, auth ${withAuth}`, () => {
			const root = mkdtempSync(join(tmpdir(), "lunr-runner-test-"));
			try {
				const home = join(root, "saved-home");
				const bin = join(root, "bin");
				mkdirSync(bin);
				const sentinels: Array<{ path: string; content: string }> = [];
				for (const config of [".pi", ".lunr"]) {
					const agent = join(home, config, "agent");
					mkdirSync(agent, { recursive: true });
					for (const file of withAuth ? ["auth.json", "auth.json.bak"] : ["auth.json.bak"]) {
						const path = join(agent, file);
						const content = `sentinel ${config}/${file}`;
						writeFileSync(path, content);
						sentinels.push({ path, content });
					}
				}
				const observation = join(root, "observation.json");
				// A fake npm exercises the real shell boundary without running the workspace suite.
				writeFileSync(
					join(bin, "npm"),
					`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const initialAuth = [path.join(process.env.HOME, ".pi", "agent", "auth.json"), path.join(process.env.HOME, ".lunr", "agent", "auth.json"), path.join(process.env.PI_CODING_AGENT_DIR, "auth.json")].some(file => fs.existsSync(file));
fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ env: process.env, args: process.argv.slice(2), initialAuth, osHome: require("node:os").homedir() }));
fs.writeFileSync(require("node:path").join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "disposable");
process.exit(${exitCode});
`,
					{ mode: 0o755 },
				);
				const result = spawnSync("bash", [runner, "--workspace=packages/coding-agent"], {
					cwd: root,
					encoding: "utf8",
					env: {
						PATH: `${bin}${delimiter}${process.env.PATH}`,
						HOME: home,
						USERPROFILE: home,
						PI_CODING_AGENT_DIR: join(home, ".lunr", "agent"),
						OPENAI_API_KEY: "fake-key",
						AWS_PROFILE: "fake-profile",
						PI_SUBAGENT_ID: "foreign-child",
						PI_SUBAGENTS_DIR: "foreign-runs",
						PI_INTERCOM_DIR: "foreign-intercom",
						NODE_OPTIONS: "--no-warnings",
						UNLISTED_PROVIDER_SECRET: "fake-secret",
						CI: "true",
					},
				});
				assert.equal(result.status, exitCode, result.stderr);
				const { env, args, initialAuth, osHome } = JSON.parse(readFileSync(observation, "utf8")) as {
					env: Record<string, string | undefined>;
					args: string[];
					initialAuth: boolean;
					osHome: string;
				};
				assert.deepEqual(args, ["test", "--workspace=packages/coding-agent"]);
				for (const name of [
					"OPENAI_API_KEY",
					"AWS_PROFILE",
					"PI_SUBAGENT_ID",
					"PI_SUBAGENTS_DIR",
					"PI_INTERCOM_DIR",
					"NODE_OPTIONS",
					"UNLISTED_PROVIDER_SECRET",
				]) {
					assert.equal(env[name], undefined, name);
				}
				assert.equal(env.CI, "true");
				assert.equal(env.PI_NO_LOCAL_LLM, "1");
				assert.notEqual(env.HOME, home);
				assert.equal(env.USERPROFILE, env.HOME);
				assert.equal(osHome, env.HOME);
				assert.equal(initialAuth, false);
				for (const name of [
					"HOME",
					"USERPROFILE",
					"PI_CODING_AGENT_DIR",
					"TMPDIR",
					"TMP",
					"TEMP",
					"XDG_CONFIG_HOME",
					"XDG_CACHE_HOME",
					"XDG_DATA_HOME",
					"APPDATA",
					"LOCALAPPDATA",
				]) {
					assert.equal(existsSync(env[name]!), false, `${name} is cleaned after exit`);
				}
				for (const { path, content } of sentinels) assert.equal(readFileSync(path, "utf8"), content);
				if (!withAuth) {
					for (const config of [".pi", ".lunr"])
						assert.equal(existsSync(join(home, config, "agent", "auth.json")), false);
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
