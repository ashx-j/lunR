import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const tsxLoader = import.meta.resolve("tsx");
const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
	const root = mkdtempSync(join(tmpdir(), "lunr-print-no-prompt-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const child = spawn(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
		cwd: root,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
			PI_OFFLINE: "1",
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timeout);
			resolvePromise({ code, stderr });
		});
	});
}

describe("print mode without a prompt", () => {
	it("exits 1 with a usage line instead of doing nothing", async () => {
		const result = await runCli(["-p", "--no-session", "--no-extensions"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("print mode needs a prompt");
		expect(result.stderr).toContain("Usage:");
	}, 30_000);
});
