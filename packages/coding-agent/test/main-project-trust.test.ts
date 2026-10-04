import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function write(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
async function startup(options: {
	trusted: boolean;
	foreign?: boolean;
	explicit?: boolean;
	selection?: "prefix" | "fork" | "resume";
	globalHistory?: boolean;
}) {
	const root = mkdtempSync(join(tmpdir(), "lunr-main-trust-"));
	roots.push(root);
	const cwd = join(root, "project");
	const foreign = join(root, "foreign");
	const agentDir = join(root, "profile");
	const globalSessions = join(root, "global-sessions");
	const encodedCwd = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const projectSessions = options.foreign ? join(agentDir, "sessions", encodedCwd) : join(root, "project-sessions");
	mkdirSync(cwd);
	mkdirSync(foreign);
	write(join(agentDir, "settings.json"), {
		sessionDir: globalSessions,
		sessionRetentionDays: 0,
		browserEnabled: false,
	});
	write(join(cwd, ".lunr/settings.json"), { sessionDir: projectSessions, sessionRetentionDays: 1 });
	const id = "11111111-1111-4111-8111-111111111111";
	if (options.foreign || options.selection)
		write(
			join(options.globalHistory ? globalSessions : projectSessions, "saved.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: options.foreign ? foreign : cwd })}\n`,
		);
	const observed = join(root, "observed.json");
	const decision = join(root, "decision.json");
	const picker = join(root, "picker.json");
	const extension = join(root, "probe.ts");
	write(
		extension,
		`import {writeFileSync} from 'node:fs'; export default pi => { pi.on('project_trust', () => { writeFileSync(${JSON.stringify(decision)}, JSON.stringify(${options.trusted})); console.error('TRUST_DECISION:${options.trusted}'); return {trusted:${JSON.stringify(options.trusted ? "yes" : "no")}, remember:false}; }); pi.on('session_start', (_,ctx) => { writeFileSync(${JSON.stringify(observed)}, JSON.stringify({cwd:ctx.cwd, directory:ctx.sessionManager.getSessionDir(), id:ctx.sessionManager.getSessionId(), trusted:ctx.isProjectTrusted()})); }); };`,
	);
	const args = [
		"--mode",
		"json",
		"--offline",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--provider",
		"openai",
		"--model",
		"gpt-6-sol",
		"--api-key",
		"fake-test-key",
		"-e",
		extension,
	];
	if (options.selection === "prefix") args.push("--session", id.slice(0, 8));
	else if (options.selection === "fork") args.push("--fork", id.slice(0, 8));
	else if (options.selection === "resume") args.push("--resume");
	else if (options.foreign) args.push("--session-id", id);
	if (options.explicit) args.push("--session-dir", join(root, "explicit-sessions"));
	const main = pathToFileURL(resolve(__dirname, "../src/main.ts")).href;
	// Replace only the picker UI. Its actual session loaders and the rest of main run normally.
	const pickerSource = `import {readFileSync,writeFileSync} from 'node:fs'; export async function selectSession(current, all) { const sessions = await current(); const allSessions = await all(); writeFileSync(${JSON.stringify(picker)}, JSON.stringify({trusted:JSON.parse(readFileSync(${JSON.stringify(decision)},'utf8')), ids:sessions.map(session=>session.id), allIds:allSessions.map(session=>session.id)})); return sessions[0]?.path ?? null; }`;
	const pickerHook =
		options.selection === "resume"
			? `import {registerHooks} from 'node:module'; registerHooks({load(url,context,nextLoad) { if (url.split('?')[0].endsWith('/cli/session-picker.ts')) return {format:'module',shortCircuit:true,source:${JSON.stringify(pickerSource)}}; return nextLoad(url,context); }});`
			: "";
	const script = `${pickerHook} const {main} = await import(${JSON.stringify(main)}); await main(${JSON.stringify(args)});`;
	const environment: Record<string, string> = {};
	for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
		if (process.env[key]) environment[key] = process.env[key]!;
	}
	Object.assign(environment, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
	const child = spawn(
		process.execPath,
		[
			"--import",
			pathToFileURL(resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs")).href,
			"--input-type=module",
			"-e",
			script,
		],
		{
			cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	await new Promise<void>((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Startup timed out: ${stderr}`));
		}, 20000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolvePromise() : reject(new Error(`Startup exited ${code}: ${stderr}\n${stdout}`));
		});
	});
	return {
		root,
		cwd,
		foreign,
		globalSessions,
		projectSessions,
		id,
		picker:
			options.selection === "resume"
				? (JSON.parse(readFileSync(picker, "utf8")) as { trusted: boolean; ids: string[]; allIds: string[] })
				: undefined,
		observed: JSON.parse(readFileSync(observed, "utf8")) as {
			cwd: string;
			directory: string;
			id: string;
			trusted: boolean;
		},
	};
}

describe("startup project session paths", () => {
	it.each([true, false])("uses project storage only after trust=%s", async (trusted) => {
		const result = await startup({ trusted });
		expect(result.observed.cwd).toBe(result.cwd);
		expect(result.observed.directory).toBe(trusted ? result.projectSessions : result.globalSessions);
		expect(result.observed.trusted).toBe(trusted);
	});
	it("preserves explicit CLI storage after denial", async () => {
		const result = await startup({ trusted: false, explicit: true });
		expect(result.observed.directory).toBe(join(result.root, "explicit-sessions"));
	});
	it("rebuilds services for a foreign cwd chosen in the approved second lookup", async () => {
		const result = await startup({ trusted: true, foreign: true });
		expect(result.observed.cwd).toBe(result.foreign);
		expect(result.observed.directory).toBe(result.globalSessions);
	});
	it("opens an existing custom session prefix after its first approval", async () => {
		const result = await startup({ trusted: true, selection: "prefix" });
		expect(result.observed.id).toBe(result.id);
		expect(result.observed.directory).toBe(result.projectSessions);
		expect(result.observed.trusted).toBe(true);
	});
	it("reports a missing custom prefix only after denial", async () => {
		await expect(startup({ trusted: false, selection: "prefix" })).rejects.toThrow(
			/TRUST_DECISION:false[\s\S]*No session found matching '11111111'/,
		);
	});
	it("rebuilds services for a foreign cwd opened by a newly approved prefix", async () => {
		const result = await startup({ trusted: true, foreign: true, selection: "prefix" });
		expect(result.observed.id).toBe(result.id);
		expect(result.observed.cwd).toBe(result.foreign);
		expect(result.observed.directory).toBe(result.globalSessions);
	});
	it("forks a custom session prefix after its first approval", async () => {
		const result = await startup({ trusted: true, selection: "fork" });
		expect(result.observed.id).not.toBe(result.id);
		expect(result.observed.cwd).toBe(result.cwd);
		expect(result.observed.directory).toBe(result.projectSessions);
	});
	it.each([true, false])("opens the resume picker after trust=%s with only its allowed storage", async (trusted) => {
		const result = await startup({ trusted, selection: "resume", globalHistory: !trusted });
		expect(result.picker).toEqual({ trusted, ids: [result.id], allIds: [result.id] });
		expect(result.observed.id).toBe(result.id);
		expect(result.observed.directory).toBe(trusted ? result.projectSessions : result.globalSessions);
	});
});
