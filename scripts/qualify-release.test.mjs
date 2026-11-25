import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheFailure, qualifyStatus } from "./qualify-release.mjs";

const rows = (pairs) => pairs.map(([cacheRead, cacheWrite]) => ({ input: 4, cacheRead, cacheWrite }));

// Live 4-request turns: master in the 2026-11-14 review (S1), then PR #263 before and after its fix.
test("cacheFailure fails flat cache reads and passes growing ones", () => {
	assert.match(cacheFailure(rows([[25352, 651], [25352, 714], [25352, 777], [25352, 840]])), /history is not read from the prompt cache/);
	assert.equal(cacheFailure(rows([[27263, 123], [27386, 65], [27451, 63], [27514, 63]])), undefined);
});

test("cacheFailure fails a turn that re-writes the history after a cold first request", () => {
	assert.match(cacheFailure(rows([[0, 28136], [27263, 936], [27263, 999], [27263, 1062]])), /re-written every request/);
});

test("qualifyStatus reads the state and reports a missing gh instead of throwing", () => {
	assert.equal(qualifyStatus("abc", { run: () => ({ status: 0, stdout: "success\n" }) }), "success");
	const missing = { status: null, stdout: undefined, stderr: undefined, error: new Error("spawnSync gh ENOENT") };
	assert.equal(qualifyStatus("abc", { run: () => missing }), "unknown (spawnSync gh ENOENT)");
});

// A fake signed-in profile and a fake CLI that records its pid and then waits, so no model is called.
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "qualify-test-"));
	const profile = join(root, "profile");
	mkdirSync(profile);
	writeFileSync(join(profile, "auth.json"), JSON.stringify({ anthropic: { type: "external_claude_code" }, openai: { key: "secret" } }));
	const cli = join(root, "cli.mjs");
	writeFileSync(cli, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.FAKE_CLI_PID, String(process.pid)); setInterval(() => {}, 1000);`);
	const runs = join(root, "tmp", `lunr-qualify-${process.getuid()}`);
	mkdirSync(join(root, "tmp"));
	return { root, profile, cli, runs, env: { ...process.env, TMPDIR: join(root, "tmp"), FAKE_CLI_PID: join(root, "cli.pid") } };
}

const script = join(import.meta.dirname, "qualify-release.mjs");
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("an interrupt removes the temporary profile copy and stops the CLI", { skip: process.platform === "win32" }, async () => {
	const { root, profile, cli, runs, env } = fixture();
	try {
		const child = spawn(process.execPath, [script, "--profile", profile, "--cli", cli], { env, stdio: "ignore" });
		const exited = new Promise((done) => child.on("exit", (code) => done(code)));
		const deadline = Date.now() + 15_000;
		while (!existsSync(env.FAKE_CLI_PID)) {
			assert.ok(Date.now() < deadline, "the fake CLI never started");
			await new Promise((done) => setTimeout(done, 50));
		}
		const [run] = readdirSync(runs);
		assert.deepEqual(JSON.parse(readFileSync(join(runs, run, "agent", "auth.json"), "utf8")), { anthropic: { type: "external_claude_code" } });
		assert.equal(statSync(join(runs, run, "agent", "auth.json")).mode & 0o777, 0o600);
		assert.equal(statSync(runs).mode & 0o777, 0o700);
		child.kill("SIGINT");
		assert.equal(await exited, 130);
		assert.deepEqual(readdirSync(runs), []);
		// SIGKILL is delivered, and the orphan reaped, a moment after the script exits.
		const pid = Number(readFileSync(env.FAKE_CLI_PID, "utf8"));
		const killDeadline = Date.now() + 5_000;
		while (alive(pid) && Date.now() < killDeadline) await new Promise((done) => setTimeout(done, 50));
		assert.equal(alive(pid), false, "the fake CLI survived the interrupt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a run removes copies left by a run that is no longer alive", { skip: process.platform === "win32" }, () => {
	const { root, cli, runs, env } = fixture();
	try {
		mkdirSync(join(runs, "run-left", "agent"), { recursive: true, mode: 0o700 });
		writeFileSync(join(runs, "run-left", "agent", "auth.json"), "{}");
		writeFileSync(join(runs, "run-left", "pid"), "2147483646");
		const result = spawnSync(process.execPath, [script, "--profile", join(root, "nologin"), "--cli", cli], { env, encoding: "utf8" });
		assert.equal(result.status, 3, result.stderr);
		assert.deepEqual(readdirSync(runs), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
