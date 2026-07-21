/**
 * lunr: native plan mode (Phase 12) — read-only tool gating + system-prompt addendum.
 *
 * While plan mode is active the InteractiveMode registers a core tool-call gate on the
 * AgentSession (see `addToolCallGate`) that blocks the `edit`/`write` tools and mutating
 * `bash` commands; read tools (read/grep/find/ls/web) stay open. The addendum below is
 * appended to the system prompt while active.
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
	"You are in plan mode. Investigate read-only, then present a concrete plan. Tell the user to run /plan off to implement.";

/** Error returned to the model when a tool call is blocked by plan mode. */
export const PLAN_MODE_BLOCK_MESSAGE = "Plan mode is active — propose a plan; no file changes.";

const BLOCKED_TOOLS = new Set(["edit", "write"]);

const MUTATING_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"chgrp",
	"ln",
	"tee",
	"truncate",
	"dd",
	"shred",
	"install",
	"patch",
	"sudo",
	"su",
	"xargs",
	"npx",
	"bunx",
	"uvx",
	"pipx",
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
	deno: new Set(["install", "add", "remove", "uninstall", "upgrade", "publish", "init"]),
	pip: new Set(["install", "uninstall"]),
	pip3: new Set(["install", "uninstall"]),
	uv: new Set(["pip", "add", "remove", "sync", "init"]),
	cargo: new Set(["add", "install", "remove", "uninstall", "update", "publish", "init", "new"]),
	gem: new Set(["install", "uninstall", "update", "push"]),
	composer: new Set(["install", "require", "remove", "update", "init"]),
	poetry: new Set(["install", "add", "remove", "update", "publish", "init", "new"]),
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

/**
 * Returns the block reason when plan mode should block this tool call, else undefined.
 */
export function planModeBlockReason(toolName: string, input: unknown): string | undefined {
	if (BLOCKED_TOOLS.has(toolName)) {
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

/** Conservative heuristic: true when the bash command may modify files or system state. */
export function isMutatingBashCommand(command: string): boolean {
	// Any output redirect outside quotes can write a file.
	if (hasUnquotedRedirect(command)) return true;

	// Every segment separated by ; | & must individually be read-only.
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
		if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
			segments.push(command.slice(start, i));
			// skip the second char of && / ||
			if ((ch === "&" || ch === "|") && command[i + 1] === ch) i++;
			start = i + 1;
		}
	}
	segments.push(command.slice(start));
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
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

	if (MUTATING_COMMANDS.has(command)) return true;
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

	return false;
}

function isMutatingGit(args: string[]): boolean {
	// Skip global flags like --no-pager / -C <dir> / -c key=val crudely: find the first
	// token that doesn't start with "-" (imperfect for -C/-c values; conservative is fine).
	let index = 0;
	while (args[index] === "--no-pager") index++;
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand) return false;
	if (subcommand.startsWith("-")) return false; // bare `git --version` etc. is read-only

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
