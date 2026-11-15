import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { deniedCommandLines } from "../src/core/permission-rule-commands.ts";
import {
	bashDenyWork,
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
			expect(rules.denied("bash", { command })?.rule).toBe("bash(git push*)");
		}
		expect(rules.denied("bash", { command: "git status" })?.rule).toBeUndefined();
		expect(rules.denied("bash", { command: 'git commit -m "push fix"' })?.rule).toBeUndefined();
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
		expect(globalRules([], ["bash(touch *)"]).denied("bash", { command })?.rule).toBe("bash(touch *)");
	});

	it("cannot see commands built while the shell runs", () => {
		const rules = globalRules([], ["bash(touch *)"]);
		expect(rules.denied("bash", { command: "T=touch; $T d24" })?.rule).toBeUndefined();
		expect(rules.denied("bash", { command: "$(echo touch) d22" })).toBeUndefined();
	});

	it("lets options and their values sit between a deny pattern's words", () => {
		const rules = globalRules([], ["bash(git push*)"]);
		expect(rules.denied("bash", { command: "git -C repo push origin" })?.rule).toBe("bash(git push*)");
		expect(rules.denied("bash", { command: "git --no-pager -c x=y push" })?.rule).toBe("bash(git push*)");
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
		expect(globalRules([], [rule]).denied("bash", { command })?.rule).toBeUndefined();
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
		expect(globalRules([], [rule]).denied("bash", { command })?.rule).toBe(rule);
	});

	// A `(` or `"` inside a here-document in `$(...)` must not hide the command after it.
	const afterSubstitution: Array<[boolean, string]> = [
		[true, `git commit -m "$(cat <<'EOF'\nAdd parser (draft\nEOF\n)" && git push`],
		[true, `git commit -m "$(cat <<'EOF'\nfix: handle "(" in names\nEOF\n)" && git push`],
		[true, `git commit -m "$(cat <<'EOF'\nsmile :)\nEOF\n)" && git push`],
		[false, `git commit -m "$(cat <<'EOF'\n1) git push --force is gone\nEOF\n)"`],
		[true, "cat <<'E O F'\nx\nE O F\ngit push"],
		[false, 'bash run.sh -c "git push"'],
		[true, "bash -euo pipefail -c 'git push'"],
		[true, `${"true; ".repeat(300)}git push`],
	];
	it.each(afterSubstitution)("bash(git push*) case %# blocks: %s", (blocked, command) => {
		expect(globalRules([], ["bash(git push*)"]).denied("bash", { command })?.rule).toBe(
			blocked ? "bash(git push*)" : undefined,
		);
	});

	it("blocks with any bash deny rule a command nested too deeply to check", () => {
		let command = "ls";
		for (let i = 0; i < 6; i++) command = `bash -c ${JSON.stringify(command)}`;
		expect(globalRules([], ["bash(git push*)"]).denied("bash", { command })).toEqual({
			rule: "bash(git push*)",
			uncheckable: true,
		});
		expect(globalRules([], ["bash(git push*)"]).denied("bash", { command: "bash -c 'ls'" })).toBeUndefined();
	});

	/** `find . -exec bash \;` x `ranges` feeding a here-document, nested `levels` deep around `leaf`. */
	const nestedFindHeredocs = (levels: number, ranges: number, leaf: string) => {
		let text = leaf;
		for (let d = levels; d >= 1; d--) text = `find .${" -exec bash \\;".repeat(ranges)} <<E${d}\n${text}\nE${d}`;
		return text;
	};

	it("queues each body once, so the text it scans stays within 5x the command", () => {
		const command = nestedFindHeredocs(4, 15, "echo hi; ".repeat(1150));
		expect(command.length).toBeGreaterThan(10000);
		expect(deniedCommandLines(command).queued).toBeLessThanOrEqual(5 * command.length);
		expect(
			globalRules([], ["bash(touch *)"]).denied("bash", { command: nestedFindHeredocs(4, 15, "touch x") }),
		).toEqual({ rule: "bash(touch *)", uncheckable: false });
	});

	it("fails closed once a check spends its work budget", () => {
		expect(deniedCommandLines("ls; ls", 100).uncheckable).toBe(false);
		expect(deniedCommandLines("ls; ls", 3).uncheckable).toBe(true);
	});

	// Commands a model writes every day, from review, against a typical deny list.
	it("keeps realistic commands far from the work budget", () => {
		const deny = ["rm -rf*", "git push*", "sudo*", "npm publish*", "curl*"];
		const script = readFileSync(join(__dirname, "fixtures", "deny-rules-deploy-script.sh"), "utf8");
		const message = Array.from({ length: 40 }, (_, i) => `- item ${i}: drop rm -rf build; git push is gone`).join(
			"\n",
		);
		const commands = [
			script,
			`bash <<'EOF'\n${script}EOF`,
			`bash -c '${script.replaceAll("'", `'\\''`)}'`,
			`git add -A && git commit -m "$(cat <<'EOF'\nfix: matcher\n\n${message}\nEOF\n)" && git log -1 --stat`,
			`docker run --rm -v "$PWD":/w -w /w node:22 sh -c 'npm ci && npm test && echo "rm -rf node_modules later"'`,
		];
		const rules = globalRules(
			[],
			deny.map((pattern) => `bash(${pattern})`),
		);
		for (const command of commands) {
			expect(rules.denied("bash", { command })).toBeUndefined();
			const { used, limit } = bashDenyWork(deny, command);
			expect(used / limit, command.slice(0, 40)).toBeLessThan(0.1);
		}
	});

	// Inputs from review that hung, overflowed the stack or ran out of memory, at about 100 KB each.
	it("stays fast for pathological rules and commands", () => {
		const many = (word: string, n: number) => word.repeat(n);
		const cases: Array<[string[], string, Record<string, unknown>]> = [
			[["bash(rm -rf*)"], "bash", { command: `rm${many(" -v", 33000)}` }],
			[["bash(git push0 --force*)"], "bash", { command: `git${many(" -v", 33000)} status` }],
			[["bash(git push --force*)"], "bash", { command: `git push${many(" -v", 33000)} origin` }],
			[["bash(rm -rf /*)"], "bash", { command: `rm -rf${many(" -v", 33000)} build` }],
			[["bash(git -v x*)"], "bash", { command: `git${many(" -v", 33000)}` }],
			[["bash(touch *)"], "bash", { command: `echo {${many(",", 100000)}` }],
			[["bash(touch *)"], "bash", { command: `find .${many(" -exec", 16000)}` }],
			[["bash(rm -rf*)"], "bash", { command: `${many("sudo ", 20000)}rm -rf x` }],
			[["bash(rm -rf*)"], "bash", { command: `${many("xargs ", 15000)}rm -rf x` }],
			[["bash(rm -rf*)"], "bash", { command: `${many("$(", 20000)}rm -rf x${many(")", 20000)}` }],
			[["bash(rm -rf*)"], "bash", { command: `${many('"$(echo ', 10000)}rm -rf x${many(')"', 10000)}` }],
			[["bash(rm -rf*)"], "bash", { command: `cat${many(" <<a", 20000)}\n${many("x\n", 20000)}` }],
			[[`bash(${"*a".repeat(13)}*b)`], "bash", { command: "a".repeat(100000) }],
			[Array.from({ length: 1000 }, (_, i) => `bash(cmd${i} -rf*)`), "bash", { command: "git status && npm test" }],
			[
				Array.from({ length: 200 }, (_, i) => `bash(gcc -o /usr${i}*)`),
				"bash",
				{ command: `gcc${many(" -Iinclude/dir", 1000)} -c main.c -o main.o` },
			],
			[["bash(touch *)"], "bash", { command: nestedFindHeredocs(4, 15, "echo hi; ".repeat(1150)) }],
			[
				Array.from({ length: 200 }, (_, i) => `bash(rm -rf /usr${i}*)`),
				"bash",
				{ command: `rm${many(" -v", 33000)}` },
			],
			[[`edit(${"**/a/".repeat(10)}b)`], "edit", { path: `${"a/".repeat(60)}c` }],
		];
		// The best of 3 runs, so a cold JIT or a GC pause on a shared CI runner doesn't flake it.
		for (const [deny, tool, input] of cases) {
			const rules = globalRules([], deny);
			const times = [0, 1, 2].map(() => {
				const started = performance.now();
				rules.denied(tool, { ...input });
				return performance.now() - started;
			});
			expect(Math.min(...times), deny[0]).toBeLessThan(500);
		}
	});

	it("caps each list, and a deny rule past the cap blocks every call of its tool", () => {
		const many = Array.from({ length: MAX_RULES + 1 }, (_, i) => `bash(tool${i} *)`);
		const rules = globalRules(many, many);
		expect(rules.allowed("bash", { command: `tool${MAX_RULES} x` })).toBe(false);
		expect(rules.denied("bash", { command: "ls" })?.rule).toBe(`bash(tool${MAX_RULES} *)`);
		expect(
			globalRules([], [`edit(${"a".repeat(MAX_RULE_LENGTH)})`]).denied("edit", { path: "x" })?.rule,
		).toBeDefined();
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
		expect(rules.denied("edit", { path: "src/escape/x.txt" })?.rule).toBe("edit(src/**)");
	});

	it("compares paths without case on macOS", () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin" });
		try {
			expect(globalRules([], ["edit(.env)"]).denied("edit", { path: ".ENV" })?.rule).toBe("edit(.env)");
		} finally {
			if (platform) Object.defineProperty(process, "platform", platform);
		}
		if (process.platform === "linux")
			expect(globalRules([], ["edit(.env)"]).denied("edit", { path: ".ENV" })?.rule).toBeUndefined();
	});

	it("reads tool names in any case and Claude Code's :* suffix, and rejects empty parentheses", () => {
		const rules = globalRules(["Bash(npm run test:*)"], ["Write(w.txt)", "bash()"]);
		expect(rules.allowed("bash", { command: "npm run test --watch" })).toBe(true);
		expect(rules.denied("write", { path: "w.txt" })?.rule).toBe("Write(w.txt)");
		expect(rules.denied("bash", { command: "ls" })?.rule).toBeUndefined();
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
		expect(rules.denied("bash", { command: "rm -rf build" })?.rule).toBe("bash(rm*)");
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
				expect(rules.denied("bash", { command: "rm -rf build" })?.rule).toBe("bash(rm*)");
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
	it("warns when an untrusted project's settings file can't be read", () => {
		mkdirSync(join(cwd, ".lunr", "settings.json"), { recursive: true });
		try {
			const manager = SettingsManager.create(cwd, join(root, "agent"), { projectTrusted: false });
			expect(manager.drainErrors().map(({ error }) => error.message)).toEqual([
				expect.stringContaining("Could not read the project's deny rules, so none apply"),
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
