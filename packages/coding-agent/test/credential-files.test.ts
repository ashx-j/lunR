import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREDENTIAL_READ_BLOCK_REASON } from "../src/core/credential-files.ts";
import { gateToolCall, resetAllPermissionContexts, setPermissionMode } from "../src/core/permissions.ts";
import { createGrepTool } from "../src/core/tools/index.ts";

let root: string;
let agentDir: string;
let project: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
	resetAllPermissionContexts();
	root = await mkdtemp(join(tmpdir(), "lunr-credentials-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await mkdir(join(agentDir, "mcp-oauth", "sha256-ab"), { recursive: true });
	await mkdir(join(project, "sub"), { recursive: true });
	await writeFile(join(agentDir, "auth.json"), '{"key":"FAKE-SECRET"}');
	await writeFile(join(agentDir, "subscriptions.json"), '{"pool":"FAKE-SECRET"}');
	await writeFile(join(agentDir, "mcp-oauth", "sha256-ab", "tokens.json"), '{"token":"FAKE-SECRET"}');
	await writeFile(join(project, "auth.json"), '{"fixture":"FAKE-SECRET"}');
	await symlink(join(agentDir, "auth.json"), join(project, "notes.json"));
	await symlink(agentDir, join(project, "profile"));
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	resetAllPermissionContexts();
	await rm(root, { recursive: true, force: true });
});

const gate = (toolName: string, input: Record<string, unknown>) => gateToolCall(toolName, input, project);

describe("lunR's saved logins", () => {
	// Inputs are built per test because the paths exist only after beforeEach.
	it.each<[string, () => Record<string, unknown>]>([
		["read", () => ({ path: join(agentDir, "auth.json") })],
		["read", () => ({ path: "notes.json" })],
		["read", () => ({ path: "sub/../../agent/subscriptions.json" })],
		["read", () => ({ path: "profile/mcp-oauth/sha256-ab/tokens.json" })],
		["grep", () => ({ pattern: "x", path: "profile/mcp-oauth" })],
		["bash", () => ({ command: "cat ../agent/auth.json" })],
		["bash", () => ({ command: "jq . <profile/subscriptions.json | head" })],
		["bash", () => ({ command: "cp 'profile/auth.json' /tmp/x" })],
		["bash", () => ({ command: "base64 --input=profile/mcp-oauth/sha256-ab/tokens.json" })],
	])("refuses case %# (%s) in every mode", async (toolName, input) => {
		for (const mode of ["yolo", "auto", "read-only"] as const) {
			setPermissionMode(mode);
			expect(await gate(toolName, input())).toEqual({ block: true, reason: CREDENTIAL_READ_BLOCK_REASON });
		}
	});

	it.each([
		["read", { path: "auth.json" }],
		["bash", { command: "cat auth.json; git log -- src/auth.json" }],
		["bash", { command: "ls profile" }],
	])("allows %s %j, which is not a saved login", async (toolName, input) => {
		setPermissionMode("yolo");
		expect(await gate(toolName, input)).toBeUndefined();
	});

	it("drops grep matches inside saved logins when searching a parent directory", async () => {
		const result = await createGrepTool(project).execute("grep-credentials", { pattern: "FAKE-SECRET", path: "." });
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain('auth.json:1: {"fixture":"FAKE-SECRET"}');
		const searchProfile = await createGrepTool(project).execute("grep-profile", {
			pattern: "FAKE-SECRET",
			path: "profile",
		});
		const profileText = searchProfile.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(profileText).not.toContain('"key"');
		expect(profileText).not.toContain('"pool"');
		expect(profileText).not.toContain('"token"');
		expect(profileText).toContain("Skipped matches in lunR's saved logins");
	});
});
