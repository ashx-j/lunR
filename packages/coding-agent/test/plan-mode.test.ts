import { describe, expect, it } from "vitest";
import {
	isMutatingBashCommand,
	PLAN_MODE_ADDENDUM,
	PLAN_MODE_BLOCK_MESSAGE,
	planModeBlockReason,
} from "../src/core/plan-mode.ts";

describe("planModeBlockReason", () => {
	it("blocks edit and write unconditionally", () => {
		expect(planModeBlockReason("edit", { path: "a.ts" })).toBe(PLAN_MODE_BLOCK_MESSAGE);
		expect(planModeBlockReason("write", { path: "a.ts" })).toBe(PLAN_MODE_BLOCK_MESSAGE);
	});

	it("allows read tools", () => {
		expect(planModeBlockReason("read", { path: "a.ts" })).toBeUndefined();
		expect(planModeBlockReason("grep", { pattern: "x" })).toBeUndefined();
		expect(planModeBlockReason("find", {})).toBeUndefined();
		expect(planModeBlockReason("ls", {})).toBeUndefined();
		expect(planModeBlockReason("web_search", { q: "x" })).toBeUndefined();
	});

	it("allows read-only bash and includes the command in the block reason", () => {
		expect(planModeBlockReason("bash", { command: "ls -la" })).toBeUndefined();
		const reason = planModeBlockReason("bash", { command: "rm -rf dist" });
		expect(reason).toContain(PLAN_MODE_BLOCK_MESSAGE);
		expect(reason).toContain("rm -rf dist");
	});

	it("allows bash with a missing/non-string command (defensive)", () => {
		expect(planModeBlockReason("bash", {})).toBeUndefined();
		expect(planModeBlockReason("bash", undefined)).toBeUndefined();
	});

	it("exposes a plan-mode system-prompt addendum", () => {
		expect(PLAN_MODE_ADDENDUM).toContain("plan mode");
		expect(PLAN_MODE_ADDENDUM).toContain("/plan off");
	});
});

describe("isMutatingBashCommand", () => {
	it("allows common read-only commands", () => {
		for (const command of [
			"ls -la",
			"cat package.json",
			"grep -rn foo src",
			"rg TODO",
			"find . -name '*.ts'",
			"pwd",
			"echo hello",
			"head -20 file.ts",
			"wc -l src/*.ts",
			"git status",
			"git log --oneline -5",
			"git diff",
			"git diff --stat",
			"git show HEAD",
			"git branch",
			"git branch -a",
			"git tag",
			"git tag -l",
			"git remote -v",
			"npm test",
			"npm run build",
			"node --version",
			"FOO=bar grep x y",
			"cat a.txt && grep b a.txt",
			"ls | wc -l",
			"echo 'a > b'",
			'echo "a > b"',
		]) {
			expect(isMutatingBashCommand(command), command).toBe(false);
		}
	});

	it("blocks file-mutating commands", () => {
		for (const command of [
			"rm -rf dist",
			"mv a b",
			"cp a b",
			"mkdir -p out",
			"touch newfile",
			"chmod +x script.sh",
			"ln -s a b",
			"tee out.txt",
			"sed -i 's/a/b/' file.ts",
			"sed --in-place 's/a/b/' file.ts",
			"find . -name '*.tmp' -delete",
			"find . -exec rm {} ;",
			"/bin/rm file",
		]) {
			expect(isMutatingBashCommand(command), command).toBe(true);
		}
	});

	it("blocks output redirects outside quotes", () => {
		expect(isMutatingBashCommand("echo hello > file.txt")).toBe(true);
		expect(isMutatingBashCommand("cat a >> b")).toBe(true);
		expect(isMutatingBashCommand("ls > /tmp/list.txt")).toBe(true);
	});

	it("blocks mutating git subcommands", () => {
		for (const command of [
			"git add .",
			"git commit -m 'x'",
			"git push",
			"git pull",
			"git checkout main",
			"git switch -c feat",
			"git reset --hard",
			"git merge feature",
			"git rebase main",
			"git stash",
			"git clean -fd",
			"git config user.name x",
			"git branch new-branch",
			"git branch -d old",
			"git tag v1.0",
			"git remote add origin url",
		]) {
			expect(isMutatingBashCommand(command), command).toBe(true);
		}
	});

	it("blocks package installs and system managers", () => {
		for (const command of [
			"npm install lodash",
			"npm install",
			"pnpm add react",
			"yarn remove react",
			"bun add zod",
			"pip install requests",
			"uv pip install requests",
			"cargo add serde",
			"apt-get install curl",
			"brew install ripgrep",
			"npx some-tool",
		]) {
			expect(isMutatingBashCommand(command), command).toBe(true);
		}
	});

	it("blocks arbitrary runners and mutation hidden in later segments", () => {
		expect(isMutatingBashCommand("sudo apt update")).toBe(true);
		expect(isMutatingBashCommand("sh -c 'rm x'")).toBe(true);
		expect(isMutatingBashCommand("ls && rm -rf dist")).toBe(true);
		expect(isMutatingBashCommand("cat ok.txt ; rm bad.txt")).toBe(true);
		expect(isMutatingBashCommand("ls | xargs rm")).toBe(true);
	});
});
