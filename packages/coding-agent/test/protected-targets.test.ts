import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateToolCall, resetAllPermissionContexts, setPermissionMode } from "../src/core/permissions.ts";
import { resolveToCwd } from "../src/core/tools/path-utils.ts";

let profile: string;
let previousAgentDir: string | undefined;
let agentDir: string;
beforeEach(async () => {
	resetAllPermissionContexts();
	profile = await mkdtemp(join(tmpdir(), "lunr-target-policy-"));
	agentDir = join(profile, "agent space");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(join(agentDir, "agents"), { recursive: true });
	await mkdir(join(profile, ".lunr"));
});
afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	resetAllPermissionContexts();
	await rm(profile, { recursive: true, force: true });
});

describe("protected destinations", () => {
	it("blocks all execution-supported representations in writable modes", async () => {
		for (const mode of ["yolo", "auto"] as const) {
			setPermissionMode(mode);
			for (const target of [
				join(agentDir, "settings.json"),
				join(agentDir, "install-features.json"),
				join(agentDir, "agents", "AGENTS.md"),
				join(profile, "simple-memory", "memory.md"),
				join(profile, ".lunr", "settings.json"),
			]) {
				for (const path of [
					target,
					`@${target}`,
					pathToFileURL(target).href,
					relative(profile, target),
					`~/${relative(homedir(), target)}`,
					target.replace("agent space", "agent\u202fspace"),
				]) {
					expect(resolveToCwd(path, profile)).toBe(target);
					for (const tool of ["edit", "write", "code_rewrite"]) {
						expect(
							(await gateToolCall(tool, { path, dry_run: false }, profile))?.block,
							`${mode}/${tool}/${path}`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("checks symlink files and parents even when a protected destination does not exist", async () => {
		const settings = join(agentDir, "settings.json");
		await writeFile(settings, "original");
		const alias = join(profile, "alias.json");
		await symlink(settings, alias);
		await symlink(agentDir, join(profile, "alias-agent"), "dir");
		await symlink(join(agentDir, "agents"), join(profile, "alias-instructions"), "dir");
		for (const path of [
			alias,
			join(profile, "alias-agent", "install-features.json"),
			join(profile, "alias-instructions", "new-model", "AGENTS.md"),
		]) {
			expect((await gateToolCall("write", { path }, profile))?.block, path).toBe(true);
		}
		expect(await readFile(settings, "utf8")).toBe("original");
	});

	it("fails closed for an unresolved symlink to a not-yet-created protected file", async () => {
		const alias = join(profile, "alias.json");
		await symlink(join(agentDir, "settings.json"), alias);
		expect((await gateToolCall("write", { path: alias }, profile))?.reason).toContain(
			"Cannot validate mutation target",
		);
	});

	it("checks a protected requested name even when it links outside the instruction tree", async () => {
		const normal = join(profile, "ordinary.md");
		await writeFile(normal, "ordinary");
		const link = join(agentDir, "agents", "AGENTS.md");
		await symlink(normal, link);
		expect((await gateToolCall("edit", { path: link }, profile))?.block).toBe(true);
		expect(await gateToolCall("write", { path: normal }, profile)).toBeUndefined();
	});
});
