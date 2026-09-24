import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installCandidate } from "./remote-pty-probe-install.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "lunr-pty-tui-"));
const install = join(directory, "install");
const home = join(directory, "home");
const agentDir = join(home, ".lunr", "agent");
const workspace = join(directory, "workspace");
const temp = join(directory, "temp");
const record = { experiment: "Real worktree CLI TUI under candidate PTY; isolated profile" };
try {
	for (const path of [agentDir, workspace, temp]) await mkdir(path, { recursive: true });
	record.cleanInstall = await installCandidate(install, directory);
	const probe = fileURLToPath(new URL("./remote-pty-tui-probe.cjs", import.meta.url));
	const cli = join(root, "packages", "coding-agent", "dist", "cli.js");
	record.runtime = JSON.parse(execFileSync(process.execPath, [probe, install, cli, workspace, home, agentDir, temp], { cwd: workspace, encoding: "utf8", timeout: 35_000 }));
} catch (error) {
	record.failure = String(error?.stack ?? error);
	process.exitCode = 1;
} finally {
	let removed = false;
	for (let attempt = 0; attempt < 15 && !removed; attempt++) {
		try {
			await rm(directory, { recursive: true, force: true });
			removed = true;
		} catch (error) {
			if (attempt === 14) record.cleanupFailure = String(error);
			else await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	if (!removed) process.exitCode = 1;
	console.log(JSON.stringify(record, null, 2));
}
