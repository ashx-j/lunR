import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lspExtension from "../src/builtin-extensions/pi-lsp-extension/src/index.ts";
import { CREDENTIAL_BLOCK_REASON, credentialWalkFilter } from "../src/core/credential-files.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { gateToolCall, resetAllPermissionContexts, setPermissionMode } from "../src/core/permissions.ts";
import {
	CREDENTIALS_FILE_WRITE_BLOCK_REASON,
	LUNR_MANAGED_STATE_WRITE_BLOCK_REASON,
} from "../src/core/protected-targets.ts";
import { createAllToolDefinitions, createFindTool, createGrepTool, createReadTool } from "../src/core/tools/index.ts";

let root: string;
let agentDir: string;
let project: string;
let previousAgentDir: string | undefined;
const windows = process.platform === "win32";

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
	await writeFile(join(agentDir, "settings.json"), "{}");
	await writeFile(join(project, "auth.json"), '{"fixture":"FAKE-SECRET"}');
	await symlink(join(agentDir, "auth.json"), join(project, "notes.json"));
	await symlink(agentDir, join(project, "profile"));
	// The bash glob check reuses the profile dir of the last lookup; this one reads the new profile.
	credentialWalkFilter(agentDir);
});

afterEach(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	resetAllPermissionContexts();
	await rm(root, { recursive: true, force: true });
});

const gate = (toolName: string, input: Record<string, unknown>) => gateToolCall(toolName, input, project);
/**
 * Tables name the scratch profile `<profile>` so test titles stay readable. Bash gets it with `/`
 * separators, since an unquoted `\` is an escape there. `<native>` keeps the platform's separators,
 * `<url>` is the file URL and `<msys>` is the Git Bash spelling (`/d/a/agent` for `D:\a\agent`),
 * `<cygwin>` and `<wsl>` the Cygwin and WSL ones. `<drive>` and `<below-drive>` split `<msys>` into
 * its drive root (`/d`) and the rest. On POSIX all but `<url>` name the same path.
 */
function withProfile(input: Record<string, unknown>, toolName: string): Record<string, unknown> {
	const slashed = agentDir.replaceAll(sep, "/");
	const msys = slashed.replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
	const swap = (value: unknown): unknown => {
		if (typeof value === "string") {
			return value
				.replaceAll("<profile>", toolName === "bash" ? slashed : agentDir)
				.replaceAll("<native>", agentDir)
				.replaceAll("<url>", pathToFileURL(agentDir).href)
				.replaceAll("<msys>", msys)
				.replaceAll("<cygwin>", windows ? `/cygdrive${msys}` : agentDir)
				.replaceAll("<wsl>", windows ? `/mnt${msys}` : agentDir)
				.replaceAll("<drive>", windows ? msys.slice(0, 2) : "/")
				.replaceAll("<below-drive>", msys.slice(windows ? 3 : 1));
		}
		if (Array.isArray(value)) return value.map(swap);
		if (value && typeof value === "object")
			return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swap(v)]));
		return value;
	};
	return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, swap(value)]));
}
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.map((part) => part.text ?? "").join("");

/** Every tool lunR ships with a path-like argument: the core tools and the LSP extension's tools. */
function builtInTools(): Array<ToolDefinition> {
	const registered: Array<ToolDefinition> = [];
	// Record registrations; every other extension API call or property (pi.events.on) is a no-op.
	const noop: object = new Proxy(() => undefined, {
		get: (_target, key) =>
			key === "registerTool" ? (tool: ToolDefinition) => registered.push(tool) : key === "then" ? undefined : noop,
	});
	const pi = noop;
	lspExtension(pi as ExtensionAPI);
	return [...Object.values(createAllToolDefinitions(project)), ...registered];
}

/** String and string-array parameters, each a place a model could put a path. */
function stringParams(tool: ToolDefinition): Array<{ name: string; array: boolean }> {
	return Object.entries(tool.parameters.properties ?? {}).flatMap(([name, schema]) => {
		if (schema.type === "string") return [{ name, array: false }];
		if (schema.type === "array" && schema.items?.type === "string") return [{ name, array: true }];
		return [];
	});
}

// Tools without a string argument cannot name a file. Add a tool here only with the reason.
const EXEMPT: Record<string, string> = {};

describe("lunR's saved logins", () => {
	it("refuses every built-in tool's string arguments that name a saved login, in every mode", async () => {
		const tools = builtInTools();
		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "grep", "ast_search", "code_rewrite"]),
		);
		for (const tool of tools) {
			const params = stringParams(tool);
			if (params.length === 0) {
				expect(EXEMPT[tool.name], `${tool.name} has no string argument; cover it or exempt it`).toBeDefined();
				continue;
			}
			for (const location of [
				join(agentDir, "auth.json"),
				"profile/subscriptions.json",
				"sub/../../agent/mcp-oauth/sha256-ab/tokens.json",
			]) {
				for (const param of params) {
					const input = { [param.name]: param.array ? [location] : location };
					for (const mode of ["yolo", "auto", "ask", "read-only"] as const) {
						setPermissionMode(mode);
						const result = await gate(tool.name, input);
						const label = `${tool.name}.${param.name} = ${location} (${mode})`;
						expect(result?.block, label).toBe(true);
						// A write tool aimed at one of these meets the write protection of that file or tree first.
						expect(
							[
								CREDENTIAL_BLOCK_REASON,
								CREDENTIALS_FILE_WRITE_BLOCK_REASON,
								LUNR_MANAGED_STATE_WRITE_BLOCK_REASON,
							],
							label,
						).toContain(result?.reason);
					}
				}
			}
		}
	});

	it.each<[string, Record<string, unknown>]>([
		["mcp", { tool: "fs_read", args: { path: "<profile>/auth.json" } }],
		["some_extension_tool", { files: ["readme.md", "profile/mcp-oauth"] }],
		["fetch_content", { url: "<url>/subscriptions.json" }],
		["read", { path: "@<profile>/auth.json" }],
		["bash", { command: "cat ../agent/auth.json" }],
		["bash", { command: "jq . <profile/subscriptions.json | head" }],
		["bash", { command: "cd <profile> && cat auth.json" }],
		["bash", { command: "cd profile/mcp-oauth; base64 --input=sha256-ab/tokens.json" }],
		["bash", { command: "ls -la <profile>/mcp-oauth" }],
		["bash", { command: `cat "${join("<native>", "auth.json")}"` }],
		["bash", { command: "cat <msys>/subscriptions.json" }],
		["bash", { command: "cat <cygwin>/auth.json" }],
		["bash", { command: "cat <wsl>/auth.json" }],
		["bash", { command: "cd <drive> && cat <below-drive>/auth.json" }],
	])("refuses %s %j", async (toolName, input) => {
		expect(await gate(toolName, withProfile(input, toolName))).toEqual({
			block: true,
			reason: CREDENTIAL_BLOCK_REASON,
		});
	});

	it.each<[string, Record<string, unknown>]>([
		["read", { path: "auth.json" }],
		["ls", { path: "profile" }],
		["grep", { pattern: "x", path: "<profile>" }],
		["write", { path: "notes.md", content: "cat <profile>/auth.json prints the key" }],
		["bash", { command: "cat auth.json; git log -- src/auth.json" }],
		["bash", { command: "ls <profile>" }],
	])("allows %s %j, which reads no saved login", async (toolName, input) => {
		expect(await gate(toolName, withProfile(input, toolName))).toBeUndefined();
	});

	// Spellings bash reads as a saved login, each next to one that names another file. Any `[...]`
	// counts as 1 character, so `au[x]h.json` is refused too.
	it.each<[refused: string, allowed: string]>([
		['cat <profile>/"auth".json', 'cat <profile>/"auth".json.bak'],
		["cat <profile>/a''uth.json", "cat <profile>/a''uth.md"],
		["cat <profile>/auth\\.json", 'cat "<profile>/auth\\.json"'],
		["cat <profile>/auth\\\n.json", "cat <profile>/auth\\\n.md"],
		["cat <profile>/auth.js*", "cat <profile>/settings*.json"],
		["cat <profile>/au[t]h.json", "cat <profile>/au[t]h.md"],
		["cd <profile> && cat *.json", "cat *.json"],
		["cat <profile>/mcp-*/*/tokens.json", "ls <profile>/settings.*"],
		["cat <profile>/au[[:lower:]]h.json", "cat <profile>/au[[:lower:]]h.md"],
		["cat <profile>/au[]t]h.json", "cat <profile>/au[]t]h.md"],
		["cat <profile>/./a*.json", "cat <profile>/./s*.md"],
		["cat <profile>/s*/../a*h.json", "cat sub/*/../a*h.json"],
		["cat <profile>/a*.json", 'cat <profile>/a"*".json'],
		["cat <profile>/auth.jso?", "cat <profile>/auth.jso\\?"],
		["cd -- <profile> && cat auth.json", "cd -- sub && cat auth.json"],
		["pushd <profile> && cat auth.json", "pushd sub && cat auth.json"],
		["pushd <profile> >/dev/null && cat auth.json", "pushd <profile> >/dev/null && popd && cat auth.json"],
		["cd <profile> 2>/dev/null && cat auth.json", "cd sub 2>/dev/null && cat auth.json"],
		["cd -P <profile> && cat auth.json", "cd -P sub && cat auth.json"],
		["cat <<EOF\nx\nEOF\ncat <profile>/auth.json", "cat << 'EOF'\n<profile>/*.json\nEOF"],
	])("refuses bash %j and allows %j", async (refused, allowed) => {
		const reason = { block: true, reason: CREDENTIAL_BLOCK_REASON };
		expect(await gate("bash", withProfile({ command: refused }, "bash"))).toEqual(reason);
		expect(await gate("bash", withProfile({ command: allowed }, "bash"))).toBeUndefined();
	});

	// Code and text with glob characters, from the families of real agent commands. The scratch
	// project sits next to the profile, so each of these takes the full glob path.
	const ORDINARY = [
		`python3 -c "print('x'[:-1])"`,
		"python3 -c 'import sys; print(sys.argv[1:])' a b",
		"python3 - <<'PYEOF'\nimport re\nprint(re.findall(r'[\\w-.]+', 'a-b.c'))\nlines = open('f').read().split('\\n')\nprint([l[:-1] for l in lines][0])\nPYEOF",
		"cat > tally.py <<'EOF'\nfor line in open('x'):\n    print(line[:-1], line[::-1], line[2:5])\nEOF",
		"cat >> test/app.test.js <<'EOF'\nassert.equal(headers[\"Content-Length\"], 3);\nconst a = []; f(a); g([1]);\nEOF",
		'node -e "const a = []; f(a); g([1])"',
		"node -e 'console.log(process.argv[2]?.split(\",\")[0])' x",
		'grep -E "[a-Z]+" README.md',
		"grep -rnE '[[:space:]]+$' src",
		"sed -i 's/[[:space:]]*$//' notes.md",
		"tr '[:upper:]' '[:lower:]' < in.txt",
		'echo "value: [z-a]"',
		`echo "${"*".repeat(40)} DONE ${"*".repeat(40)}"`,
		`cat > gen.c <<'EOF'\n// Don't edit by hand.\n/${"*".repeat(60)}\n * generated\n ${"*".repeat(60)}/\nEOF`,
		`ls a*a*a*a*a*a*a*a*b${"a".repeat(5000)}`,
		"ls src/*.ts test/**/*.test.ts",
		"find . -name '*.json' -not -path './node_modules/*'",
		"git ls-files '*.json' | head",
		"[ -f package.json ] && [[ -d src ]] && echo ok",
		"jq '.items[] | .name' data.json",
		"kubectl get pods -o jsonpath='{.items[*].metadata.name}'",
		"curl -s 'https://example.com/api?q=1&page=2'",
		"rg -n 'foo\\[bar\\]' src",
		"awk '{print $1}' log.txt | sort | uniq -c | sort -rn | head -5",
		'for f in src/*.ts; do wc -l "$f"; done',
		"cd sub && ls *.json && cat *.md",
		`cat > big.ts <<'EOF'\n${"const x = a[i * 2]?.b ?? c[j];\n".repeat(400)}EOF`,
		"printf '%s\\n' {a,b}*.txt",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter syntax, not a template.
		"echo $((3 * 4)) ${HOME:-x} $'a\\tb'",
		"python3 -c \"import json,sys; d=json.load(open('package.json')); print(d['scripts']['test'])\"",
	];

	it("allows ordinary commands with glob characters in code, quickly", async () => {
		const started = performance.now();
		for (const command of ORDINARY) expect(await gate("bash", { command }), command).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(50);
	});

	// The scratch root stands in for the home directory, so `$HOME/agent` is the profile.
	it.each<[refused: string, allowed: string]>([
		["cat $HOME/agent/auth.json", "cat $HOME/project/auth.json"],
		['cat "$HOME"/agent/subscriptions.json', "cat '$HOME'/agent/subscriptions.json"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter syntax, not a template.
		["cat ${HOME}/agent/mcp-oauth/sha256-ab/tokens.json", "cat ${HOMEDIR}/agent/auth.json"],
	])("expands HOME in bash %j and allows %j", async (refused, allowed) => {
		const previousHome = process.env.HOME;
		process.env.HOME = root;
		try {
			expect(await gate("bash", { command: refused })).toEqual({ block: true, reason: CREDENTIAL_BLOCK_REASON });
			expect(await gate("bash", { command: allowed })).toBeUndefined();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
	});

	// Git Bash passes USERPROFILE through unchanged; elsewhere bash has no such variable by default.
	it("expands USERPROFILE in bash on Windows only", async () => {
		const previous = process.env.USERPROFILE;
		process.env.USERPROFILE = root;
		try {
			const result = await gate("bash", { command: "cat $USERPROFILE/agent/auth.json" });
			expect(result).toEqual(windows ? { block: true, reason: CREDENTIAL_BLOCK_REASON } : undefined);
		} finally {
			if (previous === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previous;
		}
	});

	// Inside double quotes bash keeps `\/`: a separator on Windows, part of a file name elsewhere.
	it("reads a quoted backslash before a slash as bash does", async () => {
		const reason = await gate("bash", withProfile({ command: 'cat "<profile>\\/auth.json"' }, "bash"));
		expect(reason).toEqual(windows ? { block: true, reason: CREDENTIAL_BLOCK_REASON } : undefined);
	});

	it("refuses a read through a symlink under another name", async () => {
		await expect(createReadTool(project).execute("read-link", { path: "notes.json" })).rejects.toThrow(
			CREDENTIAL_BLOCK_REASON,
		);
	});

	it("skips saved logins in grep and find over a parent directory and says so", async () => {
		const grep = textOf(
			await createGrepTool(project).execute("grep-profile", { pattern: "FAKE-SECRET", path: "profile" }),
		);
		expect(grep).not.toMatch(/"key"|"pool"|"token"/);
		expect(grep).toContain("Skipped lunR's saved logins");
		const ownFile = textOf(
			await createGrepTool(project).execute("grep-project", { pattern: "FAKE-SECRET", path: "." }),
		);
		expect(ownFile).toContain('auth.json:1: {"fixture":"FAKE-SECRET"}');
		const find = textOf(
			await createFindTool(project).execute("find-profile", { pattern: "*.json", path: "profile" }),
		);
		expect(find).toContain("settings.json");
		expect(find.split("\n\n")[0]).not.toMatch(/auth\.json|subscriptions\.json|tokens\.json/);
		expect(find).toContain("Skipped lunR's saved logins");
	});

	it("maps the walk filter through a symlinked root and leaves unrelated roots alone", () => {
		const isCredential = credentialWalkFilter(join(project, "profile"));
		expect(isCredential?.(join(project, "profile", "auth.json"))).toBe(true);
		expect(isCredential?.(join(project, "profile", "mcp-oauth", "sha256-ab", "client.json"))).toBe(true);
		expect(isCredential?.(join(project, "profile", "settings.json"))).toBe(false);
		expect(credentialWalkFilter(join(project, "sub"))).toBeUndefined();
	});
});
