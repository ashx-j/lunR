import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	assertRepositoryRoot,
	localBuildCommands,
	localPackCommand,
	localTarballs,
	main as localRelease,
	prepareOutputDirectory,
	runIsolatedTests,
} from "./local-release.mjs";
import { checkPinnedDependencies, trackedManifests } from "./check-pinned-deps.mjs";
import { prepareRelease, publicationNotice, publishTag, versionCommands } from "./release.mjs";
import { WORKSPACE_TO_NPM } from "./lunr-npm-names.mjs";
import { release } from "./computer-use-packages.mjs";

function fixture(callback) {
	const root = mkdtempSync(join(tmpdir(), "lunr-release-plan-"));
	try {
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "lunr", private: true }));
		mkdirSync(join(root, "scripts"));
		writeFileSync(join(root, "scripts/publish.mjs"), "// inert fixture");
		for (const [name] of Object.entries(WORKSPACE_TO_NPM)) {
			const directory = {
				"@earendil-works/pi-ai": "ai",
				"@earendil-works/pi-tui": "tui",
				"@earendil-works/pi-agent-core": "agent",
				"@earendil-works/pi-coding-agent": "coding-agent",
			}[name];
			mkdirSync(join(root, "packages", directory), { recursive: true });
			writeFileSync(join(root, "packages", directory, "package.json"), JSON.stringify({ name, version: "0.2.26" }));
			writeFileSync(
				join(root, "packages", directory, "CHANGELOG.md"),
				"# Changelog\n\n## [Unreleased]\n\n- Fix setup.\n",
			);
		}
		return callback(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("local release accepts the actual root and rejects an unrelated or partial root", () =>
	fixture((root) => {
		assertRepositoryRoot(root);
		writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-monorepo", private: true }));
		assert.throws(() => assertRepositoryRoot(root), /repository root/);
	}));

test("forced output cannot remove the repository or an ancestor", () =>
	fixture((root) => {
		assert.throws(() => prepareOutputDirectory({ outDir: root, force: true }, root), /must not contain/);
		assert.throws(() => prepareOutputDirectory({ outDir: tmpdir(), force: true }, root), /must not contain/);
		assert.equal(existsSync(join(root, "package.json")), true);
	}));

test("build plan compiles AI offline in dependency order and reuses public staging", () => {
	const commands = localBuildCommands();
	assert.match(commands[0][1].join(" "), /packages\/tui/);
	assert.deepEqual(commands[1], ["npm", ["exec", "--no", "--", "tsgo", "-p", "packages/ai/tsconfig.build.json"]]);
	assert.match(commands[2][1].join(" "), /packages\/agent/);
	assert.match(commands[3][1].join(" "), /packages\/coding-agent/);
	assert.match(commands[4][1].join(" "), /packages\/orchestrator/);
	assert.deepEqual(localPackCommand("/repo", "/packs"), [
		process.execPath,
		["/repo/scripts/publish.mjs", "--dry-run", "--pack-dir", "/packs"],
	]);
});

test("local artifacts use public identities and include pinned native tarballs", () =>
	fixture((root) => {
		const names = [...Object.values(WORKSPACE_TO_NPM), ...release.artifacts.map((artifact) => artifact.packageName)];
		for (const name of names)
			writeFileSync(join(root, `${name.replace("@", "").replace("/", "-")}-0.2.26.tgz`), "inert");
		assert.deepEqual([...localTarballs(root, root).keys()], names);
		rmSync(join(root, "ashx-j-lunr-0.2.26.tgz"));
		assert.throws(() => localTarballs(root, root), /expected tarball/);
	}));

test("local pack-only workflow runs the current public staging command through a mocked subprocess", () =>
	fixture((root) => {
		const out = `${root}-packs`;
		const commands = [];
		try {
			localRelease({ outDir: out, skipCheck: true, skipTest: true, skipInstall: true }, root, (command, args) => {
				commands.push([command, args]);
				if (command === process.execPath) {
					assert.equal(args[0], join(root, "scripts/publish.mjs"));
					assert(args.includes("--dry-run"));
					const packDir = args.at(-1);
					for (const name of [
						...Object.values(WORKSPACE_TO_NPM),
						...release.artifacts.map((artifact) => artifact.packageName),
					])
						writeFileSync(join(packDir, `${name.replace("@", "").replace("/", "-")}-0.2.26.tgz`), "inert staged pack");
				}
			});
			assert.equal(commands.length, 6);
			assert(commands[1][1].includes("packages/ai/tsconfig.build.json"));
			assert.equal(existsSync(join(out, "tarballs/ashx-j-lunr-0.2.26.tgz")), true);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}));

test("preparation leaves reviewable branch changes without committing, tagging, or pushing", () =>
	fixture((root) => {
		const commands = [];
		prepareRelease("patch", {
			root,
			test: () => {},
			execute: (command, args) => {
				commands.push([command, args]);
				if (args[0] === "branch") return "release/0.2.27\n";
				if (command === "npm" && args[0] === "version") {
					const path = join(root, "packages/ai/package.json");
					const manifest = JSON.parse(readFileSync(path, "utf8"));
					writeFileSync(path, JSON.stringify({ ...manifest, version: "0.2.27" }));
				}
				return "";
			},
		});
		assert.equal(
			commands.some(([command, args]) => command === "git" && ["commit", "add", "tag", "push"].includes(args[0])),
			false,
		);
		assert.equal(
			commands.some(([, args]) => args.includes("--write")),
			false,
		);
		assert.match(readFileSync(join(root, "packages/ai/CHANGELOG.md"), "utf8"), /## \[Unreleased\]\n\n## \[0\.2\.27\]/);
	}));

test("preparation refuses master before changing versions", () =>
	fixture((root) => {
		const commands = [];
		assert.throws(
			() =>
				prepareRelease("patch", {
					root,
					execute: (command, args) => {
						commands.push(command);
						return args[0] === "branch" ? "master\n" : "";
					},
				}),
			/release branch/,
		);
		assert.deepEqual(commands, ["git"]);
	}));

test("explicit tag action checks remote master ancestry and versions, then pushes only the tag", () =>
	fixture((root) => {
		const commands = [];
		const sha = "a".repeat(40);
		publishTag("0.2.26", sha, {
			root,
			execute: (command, args) => {
				commands.push([command, args]);
				return args[0] === "show" ? '{"version":"0.2.26"}' : "";
			},
		});
		assert(commands.some(([, args]) => args.join(" ") === `merge-base --is-ancestor ${sha} FETCH_HEAD`));
		assert.deepEqual(commands.at(-1), ["git", ["push", "origin", "refs/tags/v0.2.26"]]);
		assert.match(publicationNotice, /npm publication/);
		assert.throws(
			() =>
				publishTag("0.2.27", sha, {
					root,
					execute: (command, args) => (args[0] === "show" ? '{"version":"0.2.26"}' : ""),
				}),
			/does not match/,
		);
	}));

test("version plans and root scripts use the supported workspace syntax", () => {
	assert(versionCommands("patch")[0][1].includes("--workspaces"));
	assert.throws(() => versionCommands("01.2.3"));
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	for (const [name, script] of Object.entries(manifest.scripts))
		if (name.startsWith("version:")) {
			assert.match(script, /--workspaces/);
			assert.doesNotMatch(script, /\s-ws(?:\s|$)/);
		}
});

test("test planning isolates credentials and all profile/cache paths, then cleans up on failure", () => {
	let home;
	let temp;
	const key = "ARBITRARY_PROVIDER_SECRET";
	const previous = process.env[key];
	process.env[key] = "fixture-secret";
	try {
		assert.throws(
			() =>
				runIsolatedTests("/repo", (command, args, options) => {
					assert.equal(command, "bash");
					assert.deepEqual(args, ["test.sh"]);
					home = options.env.HOME;
					temp = options.env.TEMP;
					assert.notEqual(home, process.env.HOME);
					assert.equal(options.env[key], undefined);
					assert.equal(options.env.NODE_OPTIONS, undefined);
					assert.equal(options.env.PI_NO_LOCAL_LLM, "1");
					for (const pathKey of [
						"HOME",
						"USERPROFILE",
						"PI_CODING_AGENT_DIR",
						"TMPDIR",
						"TEMP",
						"TMP",
						"XDG_CONFIG_HOME",
						"XDG_CACHE_HOME",
						"XDG_DATA_HOME",
						"APPDATA",
						"LOCALAPPDATA",
					])
						assert.equal(existsSync(options.env[pathKey]), true);
					writeFileSync(join(home, "sentinel"), "fake credentials");
					throw new Error("inert failure");
				}),
			/inert failure/,
		);
		assert.equal(existsSync(home), false);
		assert.equal(existsSync(temp), false);
	} finally {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
});

test("pinned validation scans tracked manifests while ignored study trees do not affect it", () =>
	fixture((root) => {
		execFileSync("git", ["init", "--quiet"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "study/\n");
		mkdirSync(join(root, "study"));
		writeFileSync(join(root, "study/package.json"), '{"dependencies":{"bad":"^1.0.0"}}');
		execFileSync("git", ["add", "package.json", ".gitignore", "packages"], { cwd: root });
		assert.equal(trackedManifests(root).includes("study/package.json"), false);
		assert.deepEqual(checkPinnedDependencies(root), []);
		writeFileSync(join(root, "packages/ai/package.json"), '{"dependencies":{"bad":"^1.0.0"}}');
		assert.match(checkPinnedDependencies(root)[0], /packages\/ai\/package.json.*bad.*\^1\.0\.0/);
	}));
