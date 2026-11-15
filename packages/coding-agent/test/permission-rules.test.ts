import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	compilePermissionRules,
	MAX_RULE_LENGTH,
	MAX_RULES,
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

	// Quoted text, here-document bodies and comments are data, so a deny rule's words appearing there must not block.
	const dataNotCommands: Array<[string, string]> = [
		["bash(rm -rf*)", `git commit -m "$(cat <<'EOF'\nchore: rm -rf build is no longer needed\nEOF\n)"`],
		["bash(git push*)", "git commit -m 'docs: explain `git push` flags'"],
		["bash(git push*)", `gh pr create --body "$(cat <<'EOF'\ngit push --force was removed.\nEOF\n)"`],
		["bash(npm publish*)", "git commit -F - <<'EOF'\nnpm publish runs from CI\nEOF"],
		["bash(git push*)", 'echo "see \\`git push\\` docs"'],
		["bash(curl*)", "echo 'use $(curl -s x) carefully'"],
		["bash(rm -rf*)", "grep -rn '`rm -rf' src/"],
		["bash(npm publish*)", "node -e 'console.log(`npm publish`)'"],
		["bash(rm -rf*)", 'echo "x" # && rm -rf build'],
		["bash(git push*)", "git log --grep push"],
		["bash(git push*)", 'git commit -m "push the fix"'],
		["bash(rm -rf*)", 'echo "rm -rf is dangerous"'],
		["bash(npm publish*)", 'grep -r "npm publish" .'],
		["bash(git push*)", "git stash push"],
		["bash(curl*)", "rg curl"],
		["bash(sudo*)", "cat sudoers.md"],
		["bash(npm publish*)", "npm run publish-docs"],
		["bash(rm -rf*)", `python3 -c "print('rm -rf')"`],
	];
	it.each(dataNotCommands)("%s lets %j run", (rule, command) => {
		expect(globalRules([], [rule]).denied("bash", { command })).toBeUndefined();
	});

	// Plain and commonly wrapped forms, checked against real bash in review.
	const wrappedForms: Array<[string, string]> = [
		["bash(rm -rf*)", "rm -r -f build"],
		["bash(sudo*)", "ls; sudo touch x"],
		["bash(sudo*)", "echo x | sudo tee /etc/x"],
		["bash(sudo*)", "env sudo touch x"],
		["bash(sudo*)", "timeout 5 sudo ls"],
		["bash(sudo*)", "command sudo ls"],
		["bash(sudo*)", "true; sudo -n true; echo sudo-ran"],
		["bash(touch *)", "setsid touch x"],
		["bash(touch *)", "ionice -c 3 touch x"],
		["bash(touch *)", "flock /tmp/l touch x"],
		["bash(touch *)", "taskset -c 0 touch x"],
		["bash(touch *)", "strace -o /dev/null touch x"],
		["bash(touch *)", "busybox touch x"],
		["bash(touch *)", "script -qc 'touch x'"],
		["bash(touch *)", "bash -c -- 'touch x'"],
		["bash(touch *)", "env -S 'touch x'"],
		["bash(touch *)", "env --split-string='touch x'"],
		["bash(touch *)", "2>/dev/null touch x"],
		["bash(touch *)", ">f touch x"],
		["bash(touch *)", "</dev/null touch x"],
		["bash(touch *)", "case x in x) touch y;; esac"],
		["bash(touch *)", "f(){ touch x; }; f"],
		["bash(touch *)", "function f { touch x; }; f"],
		["bash(touch *)", "{touch,x}"],
		["bash(touch *)", "$'touch' x"],
		["bash(touch *)", "bash <<EOF\ntouch x\nEOF"],
	];
	it.each(wrappedForms)("%s blocks %j", (rule, command) => {
		expect(globalRules([], [rule]).denied("bash", { command })).toBe(rule);
	});

	it("stays fast for pathological rules and commands", () => {
		const flags = (n: number) => Array.from({ length: n }, (_, i) => `-I/inc/dir${i}`).join(" ");
		const cases: Array<[string, string, Record<string, unknown>]> = [
			["bash(gcc -o /usr*)", "bash", { command: `gcc ${flags(400)} -c x.c` }],
			["bash(rm -rf*)", "bash", { command: `rm ${Array(400).fill("-v").join(" ")} build` }],
			[`bash(${"*a".repeat(13)}*b)`, "bash", { command: "a".repeat(5000) }],
			[`edit(${"**/a/".repeat(10)}b)`, "edit", { path: `${"a/".repeat(60)}c` }],
		];
		for (const [rule, tool, input] of cases) {
			const started = performance.now();
			globalRules([], [rule]).denied(tool, input);
			expect(performance.now() - started, rule).toBeLessThan(500);
		}
	});

	it("caps each list, and a deny rule past the cap blocks every call of its tool", () => {
		const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `bash(tool${i} *)`);
		const rules = globalRules(many, many);
		expect(rules.allowed("bash", { command: `tool${MAX_RULES} x` })).toBe(false);
		expect(rules.denied("bash", { command: "ls" })).toBe(`bash(tool${MAX_RULES} *)`);
		expect(globalRules([], [`edit(${"a".repeat(MAX_RULE_LENGTH)})`]).denied("edit", { path: "x" })).toBeDefined();
		expect(permissionRuleProblems(many, "permissions.deny")).toEqual([
			`permissions.deny has "bash(tool${MAX_RULES} *)", which is past the first ${MAX_RULES} rules. lunR blocks every bash call until you shorten or remove it.`,
		]);
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

	it("starts in an untrusted project whose .lunr folder can't be written, and writes nothing there", () => {
		const lunrDir = join(cwd, ".lunr");
		mkdirSync(lunrDir, { recursive: true });
		writeFileSync(join(lunrDir, "settings.json"), JSON.stringify({ permissions: { deny: ["bash(rm*)"] } }));
		chmodSync(lunrDir, 0o555);
		try {
			const manager = SettingsManager.create(cwd, join(root, "agent"), { projectTrusted: false });
			const settings = manager.getPermissionRuleSettings();
			expect(settings.project?.deny).toEqual(["bash(rm*)"]);
			expect(readdirSync(lunrDir)).toEqual(["settings.json"]);
		} finally {
			chmodSync(lunrDir, 0o755);
			rmSync(lunrDir, { recursive: true, force: true });
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
