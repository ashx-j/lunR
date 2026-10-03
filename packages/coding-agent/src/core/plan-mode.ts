import { computerPolicy } from "./computer-use/policy.ts";

/**
 * lunr: read-only tool-gating heuristics + system-prompt addendum.
 *
 * `gateToolCall` in permissions.ts applies `readOnlyModeBlockReason` in read-only mode:
 * `edit`/`write` and mutating `bash` are hard-blocked; read tools stay open.
 * InteractiveMode installs `READ_ONLY_MODE_ADDENDUM` via the shared system-prompt
 * append slot (same slot auto mode uses).
 *
 * Bash uses a conservative command allowlist and rejects known execution and writing
 * forms, including project scripts and package executors. Unknown forms fail closed.
 * This is a shell heuristic, not an OS sandbox. False positives are expected; the
 * user can run the command themselves or switch to a writable mode.
 */

/** Appended to the system prompt while read-only mode is active. */
export const READ_ONLY_MODE_ADDENDUM =
	"You are in read-only mode. Investigate and answer without making changes. If the user asks for a plan, you may call present_plan for approval. Do not implement until the user switches modes or approves that plan. Shell use is limited to known informational forms; project scripts, tests, package executors, and interpreter execution require a writable mode.";

export const READ_ONLY_MODE_BLOCK_MESSAGE = "Read-only mode is active; no changes allowed.";

const BLOCKED_TOOLS = new Set(["edit", "write", "memory_add", "memory_remove", "cron"]);

/** Small allowlist of read-only commands permitted in read-only mode. Everything else is rejected. */
const ALLOWED_COMMANDS = new Set([
	"ls",
	"ll",
	"cat",
	"tac",
	"grep",
	"rg",
	"find",
	"pwd",
	"echo",
	"printf",
	"head",
	"tail",
	"wc",
	"less",
	"more",
	"sort",
	"uniq",
	"diff",
	"cmp",
	"comm",
	"test",
	"[",
	"true",
	"false",
	"which",
	"whereis",
	"stat",
	"file",
	"id",
	"whoami",
	"who",
	"date",
	"cal",
	"env",
	"printenv",
	"uname",
	"hostname",
	"uptime",
	"nproc",
	"tput",
	"git",
	"gh",
	"node",
	"npm",
	"pnpm",
	"yarn",
	"bun",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"ls-files",
	"ls-tree",
	"rev-parse",
	"rev-list",
	"show-ref",
	"cat-file",
	"describe",
	"name-rev",
	"shortlog",
	"blame",
	"grep",
]);

// Branch/tag/remote accept only these listing forms. Unknown options fail closed.
const GIT_LIST_FLAGS = new Map<string, Set<string>>([
	["branch", new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "--show-current"])],
	["tag", new Set(["-l", "--list", "-n"])],
	["remote", new Set(["-v", "--verbose"])],
]);

const PACKAGE_MANAGER_READS = new Map<string, Set<string>>([
	["npm", new Set(["ls", "list", "view", "info", "explain", "outdated", "root", "prefix"])],
	["pnpm", new Set(["ls", "list", "why", "outdated"])],
	["yarn", new Set(["info", "why"])],
	["bun", new Set()],
]);

// Almost every subcommand mutates the system.
const ALWAYS_MUTATING_MANAGERS = new Set([
	"apt",
	"apt-get",
	"brew",
	"dnf",
	"yum",
	"pacman",
	"choco",
	"winget",
	"scoop",
]);

/** Only understood informational interpreter invocations are allowed. */
const RUNNER_INFO_FLAGS = new Set(["-v", "--version", "-h", "--help"]);

/** Apply-mode rewrite only. Default / omitted `dry_run` is preview and stays allowed. */
export function isCodeRewriteMutating(input: unknown): boolean {
	return (input as { dry_run?: unknown } | undefined)?.dry_run === false;
}

/**
 * Returns the block reason when read-only mode should block this tool call, else undefined.
 */
export function readOnlyModeBlockReason(toolName: string, input: unknown): string | undefined {
	if (toolName.startsWith("computer_")) {
		try {
			return computerPolicy(toolName, {})?.observation ? undefined : READ_ONLY_MODE_BLOCK_MESSAGE;
		} catch {
			return READ_ONLY_MODE_BLOCK_MESSAGE;
		}
	}
	if (toolName === "browser" && (input as { action?: unknown } | undefined)?.action === "act") {
		return `${READ_ONLY_MODE_BLOCK_MESSAGE} Browser interactions require a writable mode; observation remains available.`;
	}
	if (BLOCKED_TOOLS.has(toolName)) {
		return READ_ONLY_MODE_BLOCK_MESSAGE;
	}
	if (toolName === "code_rewrite" && isCodeRewriteMutating(input)) {
		return READ_ONLY_MODE_BLOCK_MESSAGE;
	}
	if (toolName === "bash") {
		const command = readBashCommand(input);
		if (command && isMutatingBashCommand(command)) {
			return `${READ_ONLY_MODE_BLOCK_MESSAGE} Blocked command: ${command}`;
		}
	}
	return undefined;
}

function readBashCommand(input: unknown): string {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : "";
}

/**
 * Read-only bash allowlist. A command is mutating unless every segment is a
 * known read-only command used safely (no redirects, no command substitution,
 * no process substitution, no executing-interpreter flags).
 */
export function isMutatingBashCommand(command: string): boolean {
	if (!command.trim()) return false;

	// Any output redirect outside quotes can write a file.
	if (hasUnquotedRedirect(command)) return true;

	// Command substitution / process substitution / grouped redirect syntaxes
	// bypass a simple command-name check.
	if (hasShellSubstitution(command)) return true;

	// Every segment separated by ; | & && || must individually be read-only.
	for (const segment of splitShellSegments(command)) {
		if (isMutatingSegment(segment)) return true;
	}
	return false;
}

function hasUnquotedRedirect(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === ">") return true;
	}
	return false;
}

function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		// Combined operators && and || split as one boundary.
		if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
			segments.push(command.slice(start, i));
			i++;
			start = i + 1;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			segments.push(command.slice(start, i));
			start = i + 1;
		}
	}
	segments.push(command.slice(start));
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Command substitution expands inside double quotes; single quotes keep it literal. */
function hasShellSubstitution(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote === "'") {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return true;
		if (quote === '"') {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") return true;
		if (ch === "&" && command[i + 1] === ">") return true;
	}
	return false;
}

/** Unquote shell words so quoted option spellings receive the same classification. */
function shellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && quote !== "'") {
			const next = segment[++i];
			if (next === undefined) return undefined;
			// Inside double quotes, only these characters lose their backslash.
			if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next)) word += "\\";
			word += next;
			inWord = true;
		} else if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (quote) return undefined;
	if (inWord) words.push(word);
	return words;
}

function isMutatingSegment(segment: string): boolean {
	let tokens = shellWords(segment);
	if (!tokens) return true;
	// Skip leading env assignments (FOO=bar cmd …) and command wrappers we can't see through.
	while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
		tokens = tokens.slice(1);
	}
	if (tokens.length === 0) return false;

	const command = basenameOf(tokens[0]).toLowerCase();
	const args = tokens.slice(1);

	if (ALWAYS_MUTATING_MANAGERS.has(command)) return true;

	if (command === "sed") {
		return args.some((a) => a === "-i" || a.startsWith("-i") || a.startsWith("--in-place") || /^-[^-]*i/.test(a));
	}
	if (command === "find") {
		return args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(a));
	}
	if (command === "git") {
		return isMutatingGit(args);
	}
	if (command === "gh") {
		// Allow read-only views; block everything that changes remote state.
		const sub = `${args[0] ?? ""} ${args[1] ?? ""}`;
		return ![
			"pr view",
			"pr list",
			"pr status",
			"issue view",
			"issue list",
			"issue status",
			"repo view",
			"release view",
			"release list",
			"run list",
			"run view",
			"status",
		].includes(sub.trim());
	}
	if (command === "node") return args.length !== 1 || !RUNNER_INFO_FLAGS.has(args[0]);
	if (command === "python" || command === "python3") {
		return args.length !== 1 || !["-V", "--version", "-h", "--help"].includes(args[0]);
	}
	if (["sh", "bash", "zsh", "dash"].includes(command)) {
		return args.length !== 1 || !["--version", "--help"].includes(args[0]);
	}

	const packageReads = PACKAGE_MANAGER_READS.get(command);
	if (packageReads) {
		if (args.length === 1 && RUNNER_INFO_FLAGS.has(args[0])) return false;
		// Bare managers may install or execute; flags before the operation are ambiguous.
		return !packageReads.has(args[0]?.toLowerCase());
	}
	if (command === "env") {
		// env may launch any executable or parse a command with -S.
		return args.length > 0 && !(args.length === 1 && ["--version", "--help", "-0", "--null"].includes(args[0]));
	}
	if (command === "sort") {
		return args.some((arg) => {
			const option = arg.split("=")[0];
			return (option.startsWith("--") && option.length > 2 && "--output".startsWith(option)) || /^-[^-]*o/.test(arg);
		});
	}

	// Final gate: the command must be in the read-only allowlist.
	return !ALLOWED_COMMANDS.has(command);
}

/** Global git options that take no value. Unknown leading flags are treated as mutating. */
const GIT_GLOBAL_FLAGS = new Set([
	"--no-pager",
	"--version",
	"--help",
	"-h",
	"--bare",
	"--no-replace-objects",
	"--no-optional-locks",
	"--literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
]);

/** Walk past known `git` globals. Returns the subcommand index, or -1 to block. */
function gitSubcommandIndex(args: string[]): number {
	let index = 0;
	while (index < args.length) {
		const token = args[index];
		if (!token.startsWith("-")) return index;
		if (token === "--") return index + 1;
		if (GIT_GLOBAL_FLAGS.has(token)) {
			index++;
			continue;
		}
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--namespace") {
			if (args[index + 1] === undefined) return -1;
			index += 2;
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("--namespace=")) {
			index++;
			continue;
		}
		return -1;
	}
	return index;
}

function isMutatingGit(args: string[]): boolean {
	const index = gitSubcommandIndex(args);
	if (index < 0) return true;
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand) return false;

	const listFlags = GIT_LIST_FLAGS.get(subcommand);
	if (listFlags) return args.slice(index + 1).some((arg) => !listFlags.has(arg));
	if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;
	// Read operations can still write output or invoke external diff/text converters.
	return args
		.slice(index + 1)
		.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv");
}

function basenameOf(token: string): string {
	const parts = token.split(/[\\/]/);
	return parts[parts.length - 1] ?? token;
}
