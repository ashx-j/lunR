import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilePermissionRules, parsePermissionRule, suggestAllowRule } from "../src/core/permission-rules.ts";

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

	it("matches a bare tool name for every call and ignores rules that don't parse", () => {
		const rules = globalRules(["mcp", "bash(", "not a rule"]);
		expect(rules.allowed("mcp", { tool: "x" })).toBe(true);
		expect(rules.allowed("bash", { command: "ls" })).toBe(false);
		expect(parsePermissionRule("bash(")).toBeUndefined();
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
});

describe("suggested always-allow rules", () => {
	it("names the exact command or path, and nothing when no rule could match", () => {
		expect(suggestAllowRule("bash", { command: " npm test " }, cwd)).toBe("bash(npm test)");
		expect(suggestAllowRule("bash", { command: "npm test && rm x" }, cwd)).toBeUndefined();
		expect(suggestAllowRule("edit", { path: "src/a.ts" }, cwd)).toBe(`edit(${join(cwd, "src/a.ts")})`);
		expect(suggestAllowRule("mcp", { tool: "x" }, cwd)).toBeUndefined();
	});
});
