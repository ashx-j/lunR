#!/usr/bin/env node
// Release qualification with real model turns. The test suites use no real model, so bugs that show up within
// a few subscription requests (0.2.40 shipped two: auto mode blocking everything, history never read from the
// prompt cache) pass CI. This runs at most 12 real requests through the Claude subscription route on a copy of
// a signed-in profile, prints one line per check and records a pass as the GitHub commit status
// `lunr/qualify-release` on HEAD, which `scripts/publish.mjs` requires before a stable publish.
//
//   npm run qualify -- --profile <agent dir with /login anthropic done> [--cli <cli.js>] [--no-record]
//
// --cli runs another build's CLI (nothing is recorded then, the commit is not this checkout's).
// Exit codes: 0 every check passed, 1 a check failed, 2 usage error, 3 skipped because the profile has no
// Claude subscription login. It never reads or writes ~/.lunr: every run uses a temporary copy of the profile.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const QUALIFY_STATUS_CONTEXT = "lunr/qualify-release";
const MODEL = "anthropic/claude-sonnet-5-5";
// History caching writes only the newest turn, about 65 tokens per request with these echo calls (PR #263).
// When history is not cached every request re-writes the conversation, 650 to 1,100 tokens here.
export const CACHE_WRITE_LIMIT = 300;
// Tools, system prompt and the short user prompt of the first request in an empty directory with a clean
// profile: 7,881 tokens on dev/tui bdbf2289 (2026-11-25). Raise it on purpose, with the reason in the commit.
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
	if (rows.length < 3) return `expected at least 3 requests, got ${rows.length}`;
	const failed = rows.findIndex((row) => row.error);
	if (failed !== -1) return `request ${failed + 1} failed: ${rows[failed].error}`;
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
		const child = spawn(process.execPath, [cli, ...args], {
			cwd,
			env: childEnv(agentDir),
			stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		let timedOut = false;
		const writer = stdinText === undefined ? undefined : setTimeout(() => child.stdin.write(stdinText), 1000);
		child.stdin?.on("error", () => {});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(writer);
			child.stdin?.destroy();
			done({ code, stdout, stderr, timedOut, ms: Date.now() - started });
		});
	});
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
		const [last] = run.status === 0 ? JSON.parse(run.stdout) : [];
		const state = !last ? "no runs" : last.status === "completed" ? last.conclusion : last.status;
		console.log(`info  ${file}: newest run ${state === "success" ? "succeeded" : state.toUpperCase()}${last ? ` (${last.createdAt.slice(0, 10)}, ${last.headBranch}, ${last.url})` : ""}`);
	}
}

async function main() {
	const { values } = parseArgs({ options: { profile: { type: "string" }, cli: { type: "string" }, "no-record": { type: "boolean", default: false } } });
	const root = resolve(import.meta.dirname, "..");
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
	const profile = resolve(values.profile);
	const authFile = join(profile, "auth.json");
	const auth = existsSync(authFile) ? JSON.parse(readFileSync(authFile, "utf8")) : {};
	if (auth.anthropic?.type !== "external_claude_code") {
		console.log(`SKIP  ${profile} has no Claude subscription login. Run lunr with PI_CODING_AGENT_DIR=${profile} and /login anthropic.`);
		process.exit(3);
	}

	const temp = mkdtempSync(join(tmpdir(), "lunr-qualify-"));
	const agentDir = join(temp, "agent");
	const work = join(temp, "work");
	mkdirSync(agentDir);
	mkdirSync(work);
	cpSync(authFile, join(agentDir, "auth.json"));
	// Reuse the pinned Claude Code download instead of fetching it again.
	if (existsSync(join(profile, "claude-code"))) symlinkSync(join(profile, "claude-code"), join(agentDir, "claude-code"));
	const baseSettings = existsSync(join(profile, "settings.json")) ? JSON.parse(readFileSync(join(profile, "settings.json"), "utf8")) : {};
	// A fresh login has no review model set, which is the case auto mode must handle.
	delete baseSettings.autoReviewModel;
	const useSettings = (defaultPermissionMode) =>
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...baseSettings, defaultPermissionMode }, null, 2));

	let requests = 0;
	const failures = [];
	const report = (name, failure, detail) => {
		console.log(`${failure ? "FAIL" : "ok  "}  ${name}${failure ? `: ${failure}` : detail ? ` (${detail})` : ""}`);
		if (failure) failures.push(name);
	};
	const json = (prompt) => ["-p", "--mode", "json", "--no-session", "--model", MODEL, "--thinking", "high", prompt];

	try {
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
		requests += requestUsage(autoRun.stdout).length + (bashEnd ? 1 : 0);
		const blockText = bashEnd?.isError ? (bashEnd.result?.content ?? []).map((part) => part.text ?? "").join(" ").slice(0, 300) : "";
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
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}

	console.log(`\nUsed ${requests} model requests (the auto check's review request counted from its tool call).`);
	printPublishWorkflows();
	if (failures.length > 0) {
		console.log(`\nFAILED ${failures.length} check${failures.length === 1 ? "" : "s"}. Nothing recorded.`);
		process.exit(1);
	}
	console.log("\nPASSED every check.");
	recordPass({ root, ownBuild: cli === ownCli, skip: values["no-record"], requests });
}

/** Posts the pass as a commit status on this checkout's HEAD when the run qualified exactly that commit. */
function recordPass({ root, ownBuild, skip, requests }) {
	const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
	const dirty = git("status", "--porcelain", "--untracked-files=no").stdout.trim();
	const reason = skip ? "--no-record" : !ownBuild ? "--cli ran another build" : dirty ? "tracked files have uncommitted changes" : undefined;
	if (reason) {
		console.log(`Not recorded: ${reason}.`);
		return;
	}
	const sha = git("rev-parse", "HEAD").stdout.trim();
	const post = spawnSync(
		"gh",
		["api", "-X", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", "state=success", "-f", `context=${QUALIFY_STATUS_CONTEXT}`, "-f", `description=Real-turn checks passed, ${requests} requests`],
		{ cwd: root, encoding: "utf8" },
	);
	console.log(post.status === 0 ? `Recorded ${QUALIFY_STATUS_CONTEXT} = success on ${sha}.` : `Not recorded: ${lastLine(post.stderr)}. Push ${sha} and run again.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
