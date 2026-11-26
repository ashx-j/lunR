#!/usr/bin/env node
// Release qualification with real model turns. The test suites use no real model, so bugs that show up within
// a few subscription requests (0.2.40 shipped two: auto mode blocking everything, history never read from the
// prompt cache) pass CI. This runs at most 12 real requests through the Claude subscription route on a copy of
// a signed-in profile, prints one line per check and records a pass as the GitHub commit status
// `lunr/qualify-release` on HEAD. `publish.mjs --require-qualify` checks that status; the stable workflow passes
// the flag only when the owner turns the gate on. The status is a reminder that the check ran on that commit,
// not proof: anyone with write access can set it.
//
//   npm run qualify -- --profile <agent dir with /login anthropic done> [--cli <cli.js>] [--no-record]
//   node scripts/qualify-release.mjs --check-status   (exit 0 only when HEAD has a passing status)
//
// --cli runs another build's CLI (nothing is recorded then, the commit is not this checkout's).
// Exit codes: 0 every check passed, 1 a check failed, 2 usage error, 3 skipped because the profile has no
// Claude subscription login, 4 the checks passed (or would run) but no pass could be recorded.
// It never reads or writes ~/.lunr. Each run works on a copy of only the Anthropic login and fixed settings in a
// private temp directory, removed on exit, Ctrl+C, SIGTERM, SIGHUP and errors; the next run sweeps any leftover.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const QUALIFY_STATUS_CONTEXT = "lunr/qualify-release";
const MODEL = "anthropic/claude-sonnet-5-5";
// History caching writes only the newest turn, about 65 tokens per request with these echo calls (PR #263).
// When history is not cached every request re-writes the conversation, 650 to 1,100 tokens here.
export const CACHE_WRITE_LIMIT = 300;
// Tools, system prompt and the short user prompt of the first request in an empty directory with a clean
// profile: 7,881 tokens on dev/tui bdbf2289 (2026-11-25). Raise it in the PR that adds the tool or prompt text.
export const FIRST_REQUEST_TOKEN_BUDGET = 8_800;
const STDIN_EXIT_LIMIT_MS = 60_000;
const NO_PROMPT_EXIT_LIMIT_MS = 30_000;

/** Reads `{ input, cacheRead, cacheWrite, error }` per model request from a `--mode json` event stream. */
export function requestUsage(stdout) {
	return stdout.split("\n").flatMap((line) => {
		try {
			const event = JSON.parse(line);
			if (event.type !== "message_end" || event.message?.role !== "assistant") return [];
			const usage = event.message.usage ?? {};
			return [{ input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, error: event.message.errorMessage }];
		} catch {
			return [];
		}
	});
}

/** Returns why a multi-request turn shows history missing from the prompt cache, or undefined when it is cached. */
export function cacheFailure(rows) {
	const failed = rows.findIndex((row) => row.error);
	if (failed !== -1) return `request ${failed + 1} failed: ${rows[failed].error}`;
	if (rows.length < 3) return `the model ran the 3 calls in ${rows.length} request${rows.length === 1 ? "" : "s"}, so there is no history to compare. Run again`;
	for (let i = 1; i < rows.length; i++) {
		if (rows[i].cacheRead <= rows[i - 1].cacheRead) {
			return `request ${i + 1} read ${rows[i].cacheRead} cached tokens, request ${i} read ${rows[i - 1].cacheRead}: history is not read from the prompt cache`;
		}
		if (rows[i].cacheWrite > CACHE_WRITE_LIMIT) {
			return `request ${i + 1} wrote ${rows[i].cacheWrite} tokens to the cache, limit ${CACHE_WRITE_LIMIT}: history is re-written every request`;
		}
	}
	return undefined;
}

// The bridge starts Claude Code, which changes behavior inside another Claude Code or T3 session.
function childEnv(agentDir) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(CLAUDE|CLAUDECODE|T3)[A-Z_]*$/.test(name)));
	return { ...env, PI_CODING_AGENT_DIR: agentDir };
}

/**
 * Runs the CLI and resolves on exit or after `timeoutMs`. With `stdinText`, stdin is a pipe that gets the text
 * 1 s after start and then stays open, like a slow producer that never closes its end.
 */
function runCli({ cli, args, agentDir, cwd, stdinText, timeoutMs }) {
	return new Promise((done) => {
		const started = Date.now();
		// Its own process group on POSIX, so an interrupt can stop the CLI and the Claude Code it starts.
		const child = spawn(process.execPath, [cli, ...args], {
			cwd,
			env: childEnv(agentDir),
			detached: process.platform !== "win32",
			stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		running = child;
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		let timedOut = false;
		const writer = stdinText === undefined ? undefined : setTimeout(() => child.stdin.write(stdinText), 1000);
		child.stdin?.on("error", () => {});
		const timer = setTimeout(() => {
			timedOut = true;
			killRunning();
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			running = undefined;
			clearTimeout(writer);
			child.stdin?.destroy();
			done({ code, stdout, stderr, timedOut, ms: Date.now() - started });
		});
	});
}

/** The CLI child currently running, stopped with its process group on timeout, interrupt or exit. */
let running;

function killRunning() {
	const child = running;
	if (!child?.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

/**
 * Returns a directory only this user can enter, for the temporary profile copies, after removing copies whose
 * run is no longer alive (a run killed with SIGKILL cannot clean up after itself).
 */
function privateRunsDir() {
	const base = join(tmpdir(), `lunr-qualify-${process.getuid?.() ?? userInfo().username}`);
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const info = lstatSync(base);
	if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
		throw new Error(`${base} is not a directory owned by this user. Remove it and run again.`);
	}
	chmodSync(base, 0o700);
	for (const entry of readdirSync(base)) {
		const dir = join(base, entry);
		const pid = Number(existsSync(join(dir, "pid")) ? readFileSync(join(dir, "pid"), "utf8") : 0);
		const abandoned = pid ? !pidAlive(pid) : Date.now() - statSync(dir).mtimeMs > 60_000;
		if (abandoned) rmSync(dir, { recursive: true, force: true });
	}
	return base;
}

function lastLine(text) {
	return text.trim().split("\n").at(-1)?.slice(0, 300) ?? "";
}

/** Prints whether the newest run of each active publish workflow succeeded. Informational only. */
function printPublishWorkflows() {
	const list = spawnSync("gh", ["workflow", "list", "--json", "path,state"], { encoding: "utf8" });
	if (list.status !== 0) {
		console.log(`info  publish workflows: could not query GitHub (${lastLine(list.stderr || "gh not found")})`);
		return;
	}
	const files = JSON.parse(list.stdout)
		.filter((workflow) => workflow.state === "active" && /\/publish-[^/]*\.ya?ml$/.test(workflow.path))
		.map((workflow) => workflow.path.split("/").at(-1));
	for (const file of files) {
		const run = spawnSync("gh", ["run", "list", "--workflow", file, "--limit", "1", "--json", "conclusion,status,createdAt,headBranch,url"], { encoding: "utf8" });
		if (run.status !== 0) {
			console.log(`info  ${file}: could not list runs (${lastLine(run.stderr || String(run.error))})`);
			continue;
		}
		const [last] = JSON.parse(run.stdout);
		const state = !last ? "no runs" : last.status === "completed" ? last.conclusion : last.status;
		console.log(`info  ${file}: newest run ${state === "success" ? "succeeded" : state.toUpperCase()}${last ? ` (${last.createdAt.slice(0, 10)}, ${last.headBranch}, ${last.url})` : ""}`);
	}
}

async function main() {
	const { values } = parseArgs({
		options: {
			profile: { type: "string" },
			cli: { type: "string" },
			"no-record": { type: "boolean", default: false },
			"check-status": { type: "boolean", default: false },
		},
	});
	const root = resolve(import.meta.dirname, "..");
	if (values["check-status"]) {
		const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
		const state = qualifyStatus(sha, { cwd: root });
		console.log(`Release qualification ${QUALIFY_STATUS_CONTEXT} on ${sha}: ${state}`);
		process.exit(state === "success" ? 0 : 1);
	}
	const ownCli = join(root, "packages/coding-agent/dist/cli.js");
	const cli = values.cli ? resolve(values.cli) : ownCli;
	if (!values.profile) {
		console.error("Usage: npm run qualify -- --profile <lunR agent dir signed in with /login anthropic> [--cli <cli.js>] [--no-record]");
		process.exit(2);
	}
	if (!existsSync(cli)) {
		console.error(`${cli} does not exist. Build first.`);
		process.exit(2);
	}
	const recording = !values["no-record"] && cli === ownCli;
	const notRecordable = recording ? unrecordableReason(root, cli) : undefined;
	if (notRecordable) {
		console.error(`Will not record a pass: ${notRecordable}. Commit and rebuild, or pass --no-record.`);
		process.exit(4);
	}
	const runs = privateRunsDir();
	const profile = resolve(values.profile);
	const authFile = join(profile, "auth.json");
	const auth = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : {};
	if (auth.anthropic?.type !== "external_claude_code") {
		console.log(`SKIP  ${profile} has no Claude subscription login. Run lunr with PI_CODING_AGENT_DIR=${profile} and /login anthropic.`);
		process.exit(3);
	}

	const temp = mkdtempSync(join(runs, "run-"));
	const removeTemp = () => {
		killRunning();
		rmSync(temp, { recursive: true, force: true });
	};
	process.on("exit", removeTemp);
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	]) {
		process.on(signal, () => {
			console.error(`\nStopped by ${signal}. The temporary profile copy is removed.`);
			process.exit(code);
		});
	}
	process.on("uncaughtException", (error) => {
		console.error(error);
		process.exit(1);
	});
	writeFileSync(join(temp, "pid"), String(process.pid), { mode: 0o600 });
	const agentDir = join(temp, "agent");
	const work = join(temp, "work");
	mkdirSync(agentDir, { mode: 0o700 });
	mkdirSync(work, { mode: 0o700 });
	// Only the subscription login: a real profile's auth.json can hold keys for other providers.
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: auth.anthropic }), { mode: 0o600 });
	// Reuse the pinned Claude Code download instead of fetching it again.
	if (existsSync(join(profile, "claude-code"))) symlinkSync(join(profile, "claude-code"), join(agentDir, "claude-code"));
	// Fixed settings, so packages, extensions or a review model in the owner's profile cannot change the result.
	const useSettings = (defaultPermissionMode) =>
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: MODEL.split("/")[1], defaultThinkingLevel: "high", defaultPermissionMode }),
			{ mode: 0o600 },
		);

	let requests = 0;
	const failures = [];
	const report = (name, failure, detail) => {
		console.log(`${failure ? "FAIL" : "ok  "}  ${name}${failure ? `: ${failure}` : detail ? ` (${detail})` : ""}`);
		if (failure) failures.push(name);
	};
	const json = (prompt) => ["-p", "--mode", "json", "--no-session", "--model", MODEL, "--thinking", "high", prompt];

	console.log(`Qualifying ${cli} with ${MODEL}\n`);

	// A nonce keeps one run from reading the cache entries an earlier run of the same prompt wrote.
	useSettings("yolo");
	const nonce = Math.random().toString(36).slice(2, 10);
	const cacheRun = await runCli({
		cli,
		agentDir,
		cwd: work,
		timeoutMs: 300_000,
		args: json(`Run these three bash commands one at a time, each in its own turn, waiting for each result: 'echo ${nonce}-1', 'echo ${nonce}-2', 'echo ${nonce}-3'. Then reply done.`),
	});
	const rows = requestUsage(cacheRun.stdout);
	requests += rows.length;
	for (const [i, row] of rows.entries()) console.log(`      request ${i + 1}: input ${row.input}, cacheRead ${row.cacheRead}, cacheWrite ${row.cacheWrite}`);
	report("3-turn session reads history from the prompt cache", cacheRun.timedOut ? "timed out after 300 s" : cacheFailure(rows));
	if (rows[0] && !rows[0].error) {
		const first = rows[0].input + rows[0].cacheRead + rows[0].cacheWrite;
		report(
			"first request size",
			first > FIRST_REQUEST_TOKEN_BUDGET ? `${first} tokens, budget ${FIRST_REQUEST_TOKEN_BUDGET}` : undefined,
			`${first} tokens, budget ${FIRST_REQUEST_TOKEN_BUDGET}`,
		);
	} else {
		report("first request size", "no first request to measure");
	}

	// An env-prefixed command is always sent to the reviewer (needsAutoReview), so this costs one review request.
	useSettings("auto");
	const autoRun = await runCli({ cli, agentDir, cwd: work, timeoutMs: 300_000, args: json("Run exactly this bash command once, then reply done: LUNR_QUALIFY=1 touch qualify-ok") });
	const autoEvents = autoRun.stdout.split("\n").flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
	const bashEnd = autoEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "bash");
	const blockText = bashEnd?.isError ? (bashEnd.result?.content ?? []).map((part) => part.text ?? "").join(" ").slice(0, 300) : "";
	// The review request counts only when the reviewer was reached.
	const reviewerFailed = /review model failed|has no review model|review model .* isn't available/i.test(blockText);
	requests += requestUsage(autoRun.stdout).length + (bashEnd && !reviewerFailed ? 1 : 0);
	report(
		"auto mode reviews and allows a command",
		autoRun.timedOut
			? "timed out after 300 s"
			: !bashEnd
				? `the model made no bash call${autoRun.stderr.trim() ? `, stderr: ${lastLine(autoRun.stderr)}` : ""}`
				: bashEnd.isError
					? `blocked: ${blockText}`
					: !existsSync(join(work, "qualify-ok"))
						? "the command reported success but qualify-ok does not exist"
						: undefined,
	);

	// `echo x | lunr -p` closes the pipe at once and passes even where piped input is broken. A producer 1 s
	// late that never closes stdin is what a calling program looks like (PR #252).
	useSettings("yolo");
	const stdinRun = await runCli({
		cli,
		agentDir,
		cwd: work,
		stdinText: "The secret word is banana.\n",
		timeoutMs: STDIN_EXIT_LIMIT_MS,
		args: ["-p", "--no-session", "--model", MODEL, "What is the secret word? Reply with the word only."],
	});
	requests += 1;
	report(
		"piped stdin reaches the model and lunr -p exits 0",
		stdinRun.timedOut
			? `still running after ${STDIN_EXIT_LIMIT_MS / 1000} s with stdin open, killed${/banana/i.test(stdinRun.stdout) ? "" : ", and the answer did not use stdin"}`
			: stdinRun.code !== 0
				? `exit ${stdinRun.code}: ${lastLine(stdinRun.stderr)}`
				: !/banana/i.test(stdinRun.stdout)
					? `the answer did not use stdin: ${lastLine(stdinRun.stdout)}`
					: undefined,
		`${(stdinRun.ms / 1000).toFixed(1)} s`,
	);

	const noPromptRun = await runCli({ cli, agentDir, cwd: work, timeoutMs: NO_PROMPT_EXIT_LIMIT_MS, args: ["-p", "--no-session"] });
	report(
		"lunr -p with no prompt exits non-zero",
		noPromptRun.timedOut ? `still running after ${NO_PROMPT_EXIT_LIMIT_MS / 1000} s, killed` : noPromptRun.code === 0 ? "exit 0" : undefined,
		noPromptRun.timedOut ? undefined : `exit ${noPromptRun.code}`,
	);
	removeTemp();

	console.log(`\nUsed ${requests} model requests.`);
	printPublishWorkflows();
	if (failures.length > 0) {
		console.log(`\nFAILED ${failures.length} check${failures.length === 1 ? "" : "s"}. Nothing recorded.`);
		process.exit(1);
	}
	console.log("\nPASSED every check.");
	if (!recording) {
		console.log(`Not recorded: ${values["no-record"] ? "--no-record" : "--cli ran another build"}.`);
		return;
	}
	process.exit(recordPass({ root, cli, requests }));
}

/** Why a pass on this checkout would not describe HEAD: uncommitted changes, or a build older than its sources. */
function unrecordableReason(root, cli) {
	const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
	const changed = git("status", "--porcelain", "--untracked-files=no").trim();
	const untracked = git("status", "--porcelain", "--", "packages", "scripts").split("\n").some((line) => line.startsWith("??"));
	if (changed || untracked) return "the working tree has uncommitted changes";
	const builtMs = Math.min(...buildFiles(cli).map((file) => statSync(file).mtimeMs));
	const sources = git("ls-files", "-z", "--", "packages/*/src/*", "packages/*/package.json").split("\0").filter(Boolean);
	const newer = sources.find((file) => existsSync(join(root, file)) && statSync(join(root, file)).mtimeMs > builtMs);
	return newer ? `${newer} changed after the build in dist/` : undefined;
}

/** The CLI entry and the bundled runtime it loads, the files whose hash a pass records. */
function buildFiles(cli) {
	const runtime = join(cli, "..", "node-runtime");
	const bundled = existsSync(runtime) ? readdirSync(runtime, { recursive: true }).map((file) => join(runtime, String(file))) : [];
	return [cli, ...bundled.filter((file) => statSync(file).isFile()).sort()];
}

/** sha256 over the built CLI entry and its bundled runtime, names and contents. */
export function buildHash(cli) {
	const hash = createHash("sha256");
	for (const file of buildFiles(cli)) hash.update(`${file.slice(cli.length - "cli.js".length)}\0`).update(readFileSync(file));
	return hash.digest("hex");
}

/**
 * Returns the newest `lunr/qualify-release` state on `sha`: "success", another GitHub state, "missing", or
 * "unknown (<why>)" when gh is missing, logged out or GitHub is unreachable.
 */
export function qualifyStatus(sha, { cwd, run = spawnSync } = {}) {
	const query = run(
		"gh",
		["api", `repos/{owner}/{repo}/commits/${sha}/statuses`, "--jq", `[.[] | select(.context == "${QUALIFY_STATUS_CONTEXT}")][0].state // "missing"`],
		{ cwd, encoding: "utf8" },
	);
	if (query.status === 0) return query.stdout.trim();
	return `unknown (${lastLine(query.stderr || query.error?.message || "gh failed")})`;
}

/** Posts the pass on HEAD with the build hash it tested. Returns the exit code: 0 recorded, 4 not. */
function recordPass({ root, cli, requests }) {
	const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
	const build = buildHash(cli);
	const post = spawnSync(
		"gh",
		[
			"api",
			"-X",
			"POST",
			`repos/{owner}/{repo}/statuses/${sha}`,
			"-f",
			"state=success",
			"-f",
			`context=${QUALIFY_STATUS_CONTEXT}`,
			"-f",
			`description=Real turns passed on build sha256:${build.slice(0, 16)}, ${requests} requests`,
		],
		{ cwd: root, encoding: "utf8" },
	);
	if (post.status === 0) {
		console.log(`Recorded ${QUALIFY_STATUS_CONTEXT} = success on ${sha} for build sha256:${build}.`);
		return 0;
	}
	console.log(`Not recorded: ${lastLine(post.stderr || String(post.error))}. Push ${sha} and run again.`);
	return 4;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
