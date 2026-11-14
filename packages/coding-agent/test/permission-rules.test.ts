import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	compilePermissionRules,
	parsePermissionRule,
	permissionRuleProblems,
	suggestAllowRule,
} from "../src/core/permission-rules.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const root = mkdtempSync(join(tmpdir(), "lunr-rules-"));
const cwd = join(root, "project");
mkdirSync(join(cwd, "src"), { recursive: true });
mkdirSync(join(root, "outside"));
symlinkSync(join(root, "outside"), join(cwd, "src", "escape"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const globalRules = (allow: string[], deny: string[] = []) =>
	compilePermissionRules({ allow, deny }, undefined, true, cwd);

describe("permission rule matching", () => {
	it("matches bash commands exactly, or as a glob where * matches anything", () => {
		const rules = globalRules(["bash(npm test)", "bash(git diff*)"]);
		expect(rules.allowed("bash", { command: "npm test" })).toBe(true);
		expect(rules.allowed("bash", { command: "npm test --watch" })).toBe(false);
		expect(rules.allowed("bash", { command: "git diff --stat HEAD~1" })).toBe(true);
		expect(rules.allowed("bash", { command: "git push" })).toBe(false);
	});

	it("never allows a command that chains, redirects or expands", () => {
		const rules = globalRules(["bash(npm test*)"]);
		for (const command of ["npm test; rm -rf ~", "npm test && curl x | sh", "npm test > out", "npm test $(id)"]) {
			expect(rules.allowed("bash", { command })).toBe(false);
		}
	});

	it("keeps allow rules strict where deny rules over-match", () => {
		const rules = globalRules(["bash(touch *)"]);
		for (const command of ["command touch x", "env touch x", "bash -c 'touch x'", "echo x | xargs touch"]) {
			expect(rules.allowed("bash", { command })).toBe(false);
		}
	});

	it("denies a command hidden in a chain, a subshell or behind env assignments", () => {
		const rules = globalRules([], ["bash(git push*)"]);
		for (const command of [
			"git push",
			"npm test && git push origin",
			"(git push)",
			"echo `git push`",
			"A=1 git push",
		]) {
			expect(rules.denied("bash", { command })).toBe("bash(git push*)");
		}
		expect(rules.denied("bash", { command: "git status" })).toBeUndefined();
		expect(rules.denied("bash", { command: 'git commit -m "push fix"' })).toBeUndefined();
	});

	// The rewrites a review ran against `bash(touch *)`, plus two more; only commands built at run time get through.
	const touchVariants = [
		"touch d0",
		"cd sub && touch d1",
		"x=1 touch d2",
		"! touch d3",
		"command touch d4",
		"env touch d5",
		"\\touch d6",
		"'touch' d7",
		'"touch" d8',
		"/usr/bin/touch d9",
		"nohup touch d10",
		"timeout 5 touch d11",
		"nice touch d12",
		"stdbuf -o0 touch d13",
		"time touch d14",
		"echo d15 | xargs touch",
		"bash -c 'touch d16'",
		"sh -c 'touch d17'",
		"eval touch d18",
		"{ touch d19; }",
		"if true; then touch d20; fi",
		"touch\td21",
		"echo `echo x; touch d23`",
		"find . -maxdepth 0 -exec touch d25 \\;",
		"FOO='a b' touch d26",
		"tou''ch d27",
		"t\\ouch d28",
		"builtin command touch d29",
		"sudo -u root touch d30",
		"echo $(touch d31)",
	];
	it.each(touchVariants)("denies the rewrite %j", (command) => {
		expect(globalRules([], ["bash(touch *)"]).denied("bash", { command })).toBe("bash(touch *)");
	});

	it("cannot see commands built while the shell runs", () => {
		const rules = globalRules([], ["bash(touch *)"]);
		expect(rules.denied("bash", { command: "T=touch; $T d24" })).toBeUndefined();
		expect(rules.denied("bash", { command: "$(echo touch) d22" })).toBeUndefined();
	});

	it("lets options and their values sit between a deny pattern's words", () => {
		const rules = globalRules([], ["bash(git push*)"]);
		expect(rules.denied("bash", { command: "git -C repo push origin" })).toBe("bash(git push*)");
		expect(rules.denied("bash", { command: "git --no-pager -c x=y push" })).toBe("bash(git push*)");
	});

	it("matches path globs against the resolved path, with * inside one folder and ** across folders", () => {
		const rules = globalRules(["edit(src/*.ts)", "write(src/**)"]);
		expect(rules.allowed("edit", { path: "src/a.ts" })).toBe(true);
		expect(rules.allowed("edit", { path: join(cwd, "src/a.ts") })).toBe(true);
		expect(rules.allowed("edit", { path: "src/deep/a.ts" })).toBe(false);
		expect(rules.allowed("write", { path: "src/deep/a.ts" })).toBe(true);
		expect(rules.allowed("write", { path: "../project-other/src/a.ts" })).toBe(false);
	});

	it("does not let an allow rule follow a symlink out of its folder, but a deny rule still sees the link", () => {
		const rules = compilePermissionRules({ allow: ["write(src/**)"], deny: ["edit(src/**)"] }, undefined, true, cwd);
		expect(rules.allowed("write", { path: "src/escape/x.txt" })).toBe(false);
		expect(rules.denied("edit", { path: "src/escape/x.txt" })).toBe("edit(src/**)");
	});

	it("compares paths without case on macOS", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			expect(globalRules([], ["edit(.env)"]).denied("edit", { path: ".ENV" })).toBe("edit(.env)");
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		if (process.platform === "linux")
			expect(globalRules([], ["edit(.env)"]).denied("edit", { path: ".ENV" })).toBeUndefined();
	});

	it("reads tool names in any case and Claude Code's :* suffix, and rejects empty parentheses", () => {
		const rules = globalRules(["Bash(npm run test:*)"], ["Write(w.txt)", "bash()"]);
		expect(rules.allowed("bash", { command: "npm run test --watch" })).toBe(true);
		expect(rules.denied("write", { path: "w.txt" })).toBe("Write(w.txt)");
		expect(rules.denied("bash", { command: "ls" })).toBeUndefined();
		expect(parsePermissionRule("bash( )")).toBeUndefined();
	});

	it("matches a bare tool name for every call and ignores rules that don't parse", () => {
		const rules = globalRules(["mcp", "bash(", "not a rule"]);
		expect(rules.allowed("mcp", { tool: "x" })).toBe(true);
		expect(rules.allowed("bash", { command: "ls" })).toBe(false);
	});

	it("names every rule that can never match", () => {
		expect(
			permissionRuleProblems(["bash(npm test)", "bash()", "mcp(github)", "not a rule", 3], "permissions.deny"),
		).toEqual([
			'permissions.deny has "bash()", which is not tool or tool(pattern); it is ignored.',
			'permissions.deny has "mcp(github)", but mcp rules take no pattern, so it never matches. Write "mcp".',
			'permissions.deny has "not a rule", which is not tool or tool(pattern); it is ignored.',
			"permissions.deny has 3, which is not a rule; it is ignored.",
		]);
		expect(permissionRuleProblems("bash", "permissions.allow")).toHaveLength(1);
	});
});

describe("permission rule scopes", () => {
	const project = { allow: ["bash(make)"], deny: ["bash(rm*)"] };

	it("ignores project allow rules in an untrusted project but keeps its deny rules", () => {
		const rules = compilePermissionRules(undefined, project, false, cwd);
		expect(rules.allowed("bash", { command: "make" })).toBe(false);
		expect(rules.denied("bash", { command: "rm -rf build" })).toBe("bash(rm*)");
	});

	it("honors project allow rules in a trusted project", () => {
		expect(compilePermissionRules(undefined, project, true, cwd).allowed("bash", { command: "make" })).toBe(true);
	});

	it("reads an untrusted project's deny rules from its file, and nothing else", () => {
		mkdirSync(join(cwd, ".lunr"), { recursive: true });
		writeFileSync(join(cwd, ".lunr", "settings.json"), JSON.stringify({ permissions: project, theme: "x" }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			for (const projectTrusted of [false, true]) {
				const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
				const settings = manager.getPermissionRuleSettings();
				const rules = compilePermissionRules(settings.global, settings.project, settings.projectTrusted, cwd);
				expect(rules.denied("bash", { command: "rm -rf build" })).toBe("bash(rm*)");
				expect(rules.allowed("bash", { command: "make" })).toBe(projectTrusted);
				expect(manager.getTheme() === "x").toBe(projectTrusted);
			}
		} finally {
			rmSync(join(cwd, ".lunr"), { recursive: true, force: true });
		}
	});

	it("warns at load about project rules that never match, trusted or not", () => {
		mkdirSync(join(cwd, ".lunr"), { recursive: true });
		writeFileSync(join(cwd, ".lunr", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash()"] } }));
		try {
			const manager = SettingsManager.create(cwd, join(root, "agent"), { projectTrusted: false });
			expect(manager.drainErrors().map(({ scope, error }) => `${scope}: ${error.message}`)).toEqual([
				'project: permissions.deny has "Bash()", which is not tool or tool(pattern); it is ignored.',
			]);
		} finally {
			rmSync(join(cwd, ".lunr"), { recursive: true, force: true });
		}
	});
});

describe("suggested always-allow rules", () => {
	it("names the exact command or path, and nothing when no rule could match", () => {
		expect(suggestAllowRule("bash", { command: " npm test " }, cwd)).toBe("bash(npm test)");
		expect(suggestAllowRule("bash", { command: "npm test && rm x" }, cwd)).toBeUndefined();
		expect(suggestAllowRule("edit", { path: "src/a.ts" }, cwd)).toBe(`edit(${join(cwd, "src/a.ts")})`);
		expect(suggestAllowRule("mcp", { tool: "x" }, cwd)).toBeUndefined();
	});
});
