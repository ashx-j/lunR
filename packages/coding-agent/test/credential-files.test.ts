import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import lspExtension from "../src/builtin-extensions/pi-lsp-extension/src/index.ts";
import { CREDENTIAL_BLOCK_REASON, credentialBashReason, credentialWalkFilter } from "../src/core/credential-files.ts";
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
	await mkdir(join(project, "mcp-oauth-server"));
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

	// Spellings bash reads as a saved login, each next to one that names another file.
	it.each<[refused: string, allowed: string]>([
		['cat <profile>/"auth".json', 'cat <profile>/"auth".json.bak'],
		["cat <profile>/a''uth.json", "cat <profile>/a''uth.md"],
		["cat <profile>/auth\\.json", 'cat "<profile>/auth\\.json"'],
		["cat <profile>/auth\\\n.json", "cat <profile>/auth\\\n.md"],
		["cd -- <profile> && cat auth.json", "cd -- sub && cat auth.json"],
		["pushd <profile> && cat auth.json", "pushd sub && cat auth.json"],
		["pushd <profile> >/dev/null && cat auth.json", "pushd <profile> >/dev/null && popd && cat auth.json"],
		["cd <profile> 2>/dev/null && cat auth.json", "cd sub 2>/dev/null && cat auth.json"],
		["cd -P <profile> && cat auth.json", "cd -P sub && cat auth.json"],
		["cd <profile> && cd missing-dir && cat auth.json", "cd sub && cd <profile>/missing-dir && cat auth.json"],
		["cat <<EOF\nx\nEOF\ncat <profile>/auth.json", "cat << 'EOF'\n<profile>/settings.json\nEOF"],
		// A word that cannot be examined is skipped; the words after it are still checked.
		["cd file://x/y; cat <profile>/auth.json", "cd file://x/y; cat <profile>/settings.json"],
		["cd file://x/y 2>/dev/null; cat <profile>/auth.json", "cd file://x/y 2>/dev/null; cat auth.json"],
		["cd file:///%2f; cat <profile>/auth.json", "cd file:///%2f; cat <profile>/models.json"],
		["cd <profile>; cd file://x/y; cat auth.json", "cd sub; cd file://x/y; cat auth.json"],
		["cat file://x/a* <profile>/auth.json", "cat file://x/a* <profile>/settings.json"],
		["ls file://x/*; cat <profile>/auth.json", "ls file://x/*; cat <profile>/settings.json"],
		["pushd file://x/y; cat <profile>/auth.json", "pushd file://x/y; cat auth.json"],
		// Only the real mcp-oauth tree makes plain words candidates, not a name inside a longer one.
		["cd <profile>/mcp-oauth/sha256-ab && cat tokens.json", "cd mcp-oauth-server && cat tokens.json"],
	])("refuses bash %j and allows %j", async (refused, allowed) => {
		const reason = { block: true, reason: CREDENTIAL_BLOCK_REASON };
		expect(await gate("bash", withProfile({ command: refused }, "bash"))).toEqual(reason);
		expect(await gate("bash", withProfile({ command: allowed }, "bash"))).toBeUndefined();
	});

	// Code and text with glob characters, from the families of real agent commands.
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
		expect(performance.now() - started).toBeLessThan(500);
	});

	// Input shapes that made earlier versions of the bash check quadratic or worse, built to a size.
	// Each must stay linear: 10x the text may cost at most 30x the time (10x plus noise), and 100 KB
	// at most 50 ms. Times are per call, from repeated calls of at least 5 ms in all.
	const SCALING: Array<[name: string, build: (count: number) => string]> = [
		["star banner next to .lunr", (n) => `ls ~/.lunr/ ${"*".repeat(n)} DONE`],
		["star banner in quotes", (n) => `echo "${"*".repeat(n)} DONE"`],
		["a* repeated, then a name", (n) => `ls ${"a*".repeat(n)} auth.json`],
		["nested [ then ]", (n) => `echo ${"[".repeat(n)}${"]".repeat(n)}`],
		["failing [[:x classes", (n) => `ls ~/.lunr/ ${"[[:x ".repeat(n)}:]`],
		["[a repeated", (n) => `echo ${"[a ".repeat(n)}`],
		["run of ' after a name", (n) => `cat auth.json ${"'".repeat(n)}`],
		['run of " after a name', (n) => `cat auth.json ${'"'.repeat(n)}`],
		["run of \\ after a name", (n) => `cat auth.json ${"\\".repeat(n)}`],
		["a' repeated", (n) => `echo ${"a'".repeat(n)}`],
		["many words, a name at the end", (n) => `echo ${"word ".repeat(n)}auth.json`],
		["distinct dN/auth.json words", (n) => `cat ${Array.from({ length: n }, (_, i) => `d${i}/auth.json`).join(" ")}`],
		["nested cd, a name at the end", (n) => `${"cd a && ".repeat(n)}cat auth.json`],
		["cd a && cd .., a name at the end", (n) => `${"cd a && cd .. && ".repeat(n)}cat auth.json`],
		["nested cd, no name", (n) => `${"cd a && ".repeat(n)}ls *.ts # .lunr`],
		["1 heredoc body with names", (n) => `cat <<'EOF'\n${"~/.lunr/agent/auth.json\n".repeat(n)}EOF`],
		[
			"1 heredoc body, distinct names",
			(n) => `cat <<'EOF'\n${Array.from({ length: n }, (_, i) => `${i}/auth.json`).join("\n")}\nEOF`,
		],
		["many small heredocs, a name at the end", (n) => `${"cat <<E\nx\nE\n".repeat(n)}echo auth.json`],
		["deep ../ chain", (n) => `cat ${"../".repeat(n)}auth.json`],
		["very long word with a name", (n) => `cat ${"x".repeat(n)}auth.json`],
		["very long a? word", (n) => `ls ${"a?".repeat(n)}`],
		["$HOME repeated", (n) => `cat ${"$HOME/x ".repeat(n)}auth.json`],
		["2>x repeated after a name", (n) => `cat auth.json ${"2>x ".repeat(n)}`],
		["cd into mcp-oauth-server, many words", (n) => `cd mcp-oauth-server && cat ${"a.json ".repeat(n)}`],
	];
	const sized = (build: (count: number) => string, bytes: number) => {
		let count = 1;
		while (build(count).length < bytes) count *= 2;
		let low = count / 2;
		while (count - low > 1) {
			const middle = Math.floor((low + count) / 2);
			if (build(middle).length < bytes) low = middle;
			else count = middle;
		}
		return build(count);
	};
	const msPerCall = (command: string) => {
		let best = Number.POSITIVE_INFINITY;
		for (let round = 0; round < 3; round++) {
			let calls = 0;
			const started = performance.now();
			while (performance.now() - started < 5 || calls === 0) {
				credentialBashReason(command, project);
				calls++;
			}
			best = Math.min(best, (performance.now() - started) / calls);
		}
		return best;
	};

	it.each(SCALING)("checks %s in linear time", (_name, build) => {
		const small = msPerCall(sized(build, 10_000));
		const large = msPerCall(sized(build, 100_000));
		expect(large).toBeLessThan(50);
		expect(large / small).toBeLessThan(30);
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
