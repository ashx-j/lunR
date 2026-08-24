/**
 * lunr: plan permission mode — read-only tool-gating heuristics + system-prompt addendum.
 *
 * Plan is a first-class permission mode (`PermissionMode = "plan"`). `gateToolCall`
 * in permissions.ts applies `planModeBlockReason` when the session is in plan:
 * `edit`/`write` and mutating `bash` are hard-blocked; read tools stay open.
 * InteractiveMode installs `PLAN_MODE_ADDENDUM` via the shared system-prompt
 * append slot (same slot auto mode uses).
 *
 * Bash heuristic (conservative, blocklist-based — NOT a security boundary):
 * - any `>`/`>>` redirect outside quotes blocks the whole command;
 * - the command is split on `;`, `|`, `&` separators (outside quotes) and every segment's
 *   leading command must be read-only:
 *   - known mutating commands (rm, mv, cp, mkdir, sed -i, tee, …) are blocked;
 *   - `git` is limited to read-only subcommands (status/log/diff/show/… plus flag-only
 *     branch/tag/remote); mutating subcommands (add/commit/push/checkout/…) are blocked;
 *   - package managers are limited to read-only subcommands (install/add/remove/… blocked);
 *   - arbitrary runners (sudo, xargs, npx, sh -c …) are blocked.
 * Unknown-but-not-listed commands are ALLOWED (blocklist, not allowlist) — the model is
 * additionally steered by the system-prompt addendum. False positives are expected; the
 * user can run the command themselves or exit plan mode with /plan off.
 */

/** Appended to the system prompt while plan mode is active. */
export const PLAN_MODE_ADDENDUM =
	"You are in plan mode. Investigate read-only, then present your plan by calling the present_plan tool with a concise summary — the user approves or declines it in a dialog. Do not make changes until the plan is approved. The user can also exit plan mode manually with /plan off.";

/** Error returned to the model when a tool call is blocked by plan mode. */
export const PLAN_MODE_BLOCK_MESSAGE = "Plan mode is active — propose a plan; no file changes.";

const BLOCKED_TOOLS = new Set([
	"edit",
	"write",
	"behavior_add",
	"behavior_remove",
	"memory_add",
	"memory_remove",
	"cron",
]);

/** Small allowlist of read-only commands permitted in plan mode. Everything else is rejected. */
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

const MUTATING_GIT_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"pull",
	"merge",
	"rebase",
	"reset",
	"checkout",
	"switch",
	"restore",
	"rm",
	"mv",
	"stash",
	"cherry-pick",
	"revert",
	"clean",
	"fetch",
	"config",
	"apply",
	"am",
	"init",
	"clone",
	"submodule",
	"worktree",
	"gc",
	"prune",
	"update-index",
]);

// git subcommands that are read-only only when they carry no positional args or
// mutating flags (`git branch` lists, `git branch foo` / `git branch -d foo` mutate).
const CONDITIONAL_GIT_SUBCOMMANDS = new Set(["branch", "tag", "remote"]);
const CONDITIONAL_GIT_MUTATING_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);

const PACKAGE_MANAGER_MUTATIONS: Record<string, Set<string>> = {
	npm: new Set([
		"install",
		"add",
		"remove",
		"uninstall",
		"update",
		"upgrade",
		"publish",
		"link",
		"unlink",
		"ci",
		"init",
	]),
	pnpm: new Set(["install", "add", "remove", "uninstall", "update", "upgrade", "publish", "link", "unlink", "init"]),
	yarn: new Set(["install", "add", "remove", "uninstall", "upgrade", "publish", "link", "unlink", "init"]),
	bun: new Set(["install", "add", "remove", "uninstall", "update", "upgrade", "publish", "link", "unlink", "init"]),
};

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

/** Flags that cause an interpreter to execute code and are never allowed in plan mode. */
const EXECUTING_NODE_FLAGS = new Set([
	"-e",
	"--eval",
	"-p",
	"--print",
	"-r",
	"--require",
	"--import",
	"-i",
	"--interactive",
]);
const EXECUTING_PYTHON_FLAGS = new Set(["-c", "-m", "-i", "--interactive"]);

/** Apply-mode rewrite only. Default / omitted `dry_run` is preview and stays allowed. */
export function isCodeRewriteMutating(input: unknown): boolean {
	return (input as { dry_run?: unknown } | undefined)?.dry_run === false;
}

/**
 * Returns the block reason when plan mode should block this tool call, else undefined.
 */
export function planModeBlockReason(toolName: string, input: unknown): string | undefined {
	if (BLOCKED_TOOLS.has(toolName)) {
		return PLAN_MODE_BLOCK_MESSAGE;
	}
	if (toolName === "code_rewrite" && isCodeRewriteMutating(input)) {
		return PLAN_MODE_BLOCK_MESSAGE;
	}
	if (toolName === "bash") {
		const command = readBashCommand(input);
		if (command && isMutatingBashCommand(command)) {
			return `${PLAN_MODE_BLOCK_MESSAGE} Blocked command: ${command}`;
		}
	}
	return undefined;
}

function readBashCommand(input: unknown): string {
	const command = (input as { command?: unknown } | undefined)?.command;
	return typeof command === "string" ? command : "";
}

/**
 * Plan-mode bash allowlist. A command is mutating unless every segment is a
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

/** True when the command contains command/process substitution outside quotes. */
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
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "`") return true;
		if (ch === "$" && command[i + 1] === "(") return true;
		if (ch === "<" && command[i + 1] === "(") return true;
		if (ch === ">" && command[i + 1] === "(") return true;
		if (ch === "&" && command[i + 1] === ">") return true;
	}
	return false;
}

function isMutatingSegment(segment: string): boolean {
	let tokens = segment.split(/\s+/).filter((t) => t.length > 0);
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
	if (command === "sh" || command === "bash" || command === "zsh" || command === "dash") {
		// `sh -c '…'` runs arbitrary code; bare `sh script` also executes. Block -c; allow
		// nothing else is too restrictive for `bash --version`, so allow flag-only invocations.
		return args.some((a) => a === "-c" || a === "-s") || args.some((a) => !a.startsWith("-"));
	}

	const pkgMutations = PACKAGE_MANAGER_MUTATIONS[command];
	if (pkgMutations) {
		const subcommand = args.find((a) => !a.startsWith("-"))?.toLowerCase();
		return subcommand !== undefined && pkgMutations.has(subcommand);
	}

	// Node / Python interpreters: flag-only, no executing flags, no positional scripts.
	if (command === "node") {
		return args.some((a) => !a.startsWith("-")) || args.some((a) => EXECUTING_NODE_FLAGS.has(a));
	}
	if (command === "python" || command === "python3") {
		return args.some((a) => !a.startsWith("-")) || args.some((a) => EXECUTING_PYTHON_FLAGS.has(a));
	}

	// Final gate: the command must be in the read-only allowlist.
	return !ALLOWED_COMMANDS.has(command);
}

/** Global git options that take no value. Unknown leading flags are treated as mutating. */
const GIT_GLOBAL_FLAGS = new Set([
	"--no-pager",
	"--paginate",
	"-p",
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
		if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree" || token === "--namespace") {
			if (args[index + 1] === undefined) return -1;
			index += 2;
			continue;
		}
		if (
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=") ||
			token.startsWith("--namespace=") ||
			token.startsWith("--config-env=")
		) {
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

	if (MUTATING_GIT_SUBCOMMANDS.has(subcommand)) return true;
	if (CONDITIONAL_GIT_SUBCOMMANDS.has(subcommand)) {
		const rest = args.slice(index + 1);
		return rest.some((a) => !a.startsWith("-") || CONDITIONAL_GIT_MUTATING_FLAGS.has(a));
	}
	return false;
}

function basenameOf(token: string): string {
	const parts = token.split(/[\\/]/);
	return parts[parts.length - 1] ?? token;
}
