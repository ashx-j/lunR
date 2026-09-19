import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

const sourceDir = fileURLToPath(new URL("../src/builtin-extensions/pi-intercom/", import.meta.url));
const fixtures: string[] = [];

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-intercom-"));
	fixtures.push(root);
	const extensionDir = path.join(root, "compiled extension");
	const agentDir = path.join(root, "agent profile");
	fs.mkdirSync(path.join(extensionDir, "broker"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "intercom"), { recursive: true });
	fs.writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({ type: "module" }));
	for (const file of [
		"config.ts",
		"broker/spawn.ts",
		"broker/broker.ts",
		"broker/client.ts",
		"broker/paths.ts",
		"broker/framing.ts",
	]) {
		const compiled = ts.transpileModule(fs.readFileSync(path.join(sourceDir, file), "utf8"), {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
				rewriteRelativeImportExtensions: true,
			},
		}).outputText;
		fs.writeFileSync(path.join(extensionDir, file.replace(/\.ts$/, ".js")), compiled);
	}
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
	for (const key of Object.keys(env)) {
		if (/^PI_SUBAGENT|^PI_INTERCOM/.test(key)) delete env[key];
	}
	return {
		extensionDir,
		agentDir,
		run(body: string) {
			return spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`
				import assert from 'node:assert/strict';
				import fs from 'node:fs';
				import { once } from 'node:events';
				import { spawnBrokerIfNeeded } from ${JSON.stringify(pathToFileURL(path.join(extensionDir, "broker/spawn.js")).href)};
				import { IntercomClient } from ${JSON.stringify(pathToFileURL(path.join(extensionDir, "broker/client.js")).href)};
				const agentDir = ${JSON.stringify(agentDir)};
				${body}
			`,
				],
				{ env, encoding: "utf8", timeout: 15_000, windowsHide: true },
			);
		},
	};
}

afterEach(async () => {
	for (const root of fixtures.splice(0)) {
		const pidFile = path.join(root, "agent profile", "intercom", "broker.pid");
		if (fs.existsSync(pidFile)) {
			try {
				const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
				expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
				process.kill(pid);
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
			}
		}
		await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

it("launches the compiled broker with spaced paths, reuses it, and exchanges a question and reply", () => {
	const f = fixture();
	const result = f.run(`
		const { default: childProcess } = await import('node:child_process');
		const { syncBuiltinESMExports } = await import('node:module');
		const originalSpawn = childProcess.spawn;
		let launcher, launcherExit;
		childProcess.spawn = (...args) => {
			const child = originalSpawn(...args);
			if (args[0] === 'wscript.exe') {
				launcher = child;
				launcherExit = once(child, 'exit');
			}
			return child;
		};
		syncBuiltinESMExports();
		await spawnBrokerIfNeeded('npx', ['--no-install', 'tsx']);
		if (process.platform === 'win32') {
			assert.ok(launcherExit);
			launcher.ref();
			await launcherExit;
		}
		const pidFile = agentDir + '/intercom/broker.pid';
		const pid = fs.readFileSync(pidFile, 'utf8');
		await spawnBrokerIfNeeded('npx', ['--no-install', 'tsx']);
		assert.equal(fs.readFileSync(pidFile, 'utf8'), pid);
		const first = new IntercomClient(), second = new IntercomClient();
		const registration = { cwd: agentDir, model: 'fixture', pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() };
		try {
			await first.connect({ ...registration, name: 'first' }, 'first');
			await second.connect({ ...registration, name: 'second' }, 'second');
			assert.deepEqual((await first.listSessions()).map(s => s.id).sort(), ['first', 'second']);
			const incoming = once(second, 'message');
			const sent = await first.send('second', { text: 'question', expectsReply: true });
			assert.equal(sent.delivered, true);
			const [, request] = await incoming;
			assert.equal(request.content.text, 'question');
			const answer = once(first, 'message');
			assert.equal((await second.send('first', { text: 'answer', replyTo: sent.id })).delivered, true);
			const [, reply] = await answer;
			assert.equal(reply.replyTo, sent.id);
			assert.equal(reply.content.text, 'answer');
			console.log('broker-health-and-messaging-ok');
		} finally {
			await first.disconnect();
			await second.disconnect();
		}
	`);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toContain("broker-health-and-messaging-ok");
}, 20_000);

it.each([0, 23])(
	"reports early broker exit %i with a fresh diagnostic log",
	(exitCode) => {
		const f = fixture();
		const log = path.join(f.agentDir, "intercom", "broker.stderr.log");
		fs.writeFileSync(log, "stale-error-from-previous-attempt\n");
		fs.writeFileSync(
			path.join(f.extensionDir, "broker", "broker.js"),
			`console.error('current-startup-failure'); process.exit(${exitCode});\n`,
		);
		const result = f.run(`
		await assert.rejects(spawnBrokerIfNeeded('npx', ['--no-install', 'tsx']), error => {
			assert.match(error.message, /exited before startup with code ${exitCode}/);
			assert.ok(error.message.includes('broker.stderr.log'));
			return true;
		});
	`);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(fs.readFileSync(log, "utf8").trim()).toBe("current-startup-failure");
	},
	20_000,
);

it("reports a health timeout with the log path when the process never listens", () => {
	const f = fixture();
	fs.writeFileSync(
		path.join(f.extensionDir, "broker", "broker.js"),
		`
		import fs from 'node:fs';
		fs.writeFileSync(process.env.PI_CODING_AGENT_DIR + '/intercom/broker.pid', String(process.pid));
		setInterval(() => {}, 1000);
	`,
	);
	const result = f.run(`
		await assert.rejects(spawnBrokerIfNeeded('npx', ['--no-install', 'tsx']), error => {
			assert.match(error.message, /Broker failed to start within timeout/);
			assert.ok(error.message.includes('broker.stderr.log'));
			return true;
		});
	`);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
}, 20_000);
