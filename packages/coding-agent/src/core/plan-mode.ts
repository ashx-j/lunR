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

/**
 * Env assignments that can make a read-only command run another program, either directly
 * (pagers, preloads) or by pointing it at a config file that does (HOME, XDG_*, rg and gh config).
 */
const CODE_RUNNING_ENV =
	/^(GIT_[A-Z0-9_]+|[A-Z0-9_]*PAGER|[A-Z0-9_]*EDITOR|VISUAL|[A-Z0-9_]*BROWSER|LESS[A-Z0-9_]*|LD_[A-Z0-9_]+|DYLD_[A-Z0-9_]+|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|PYTHON[A-Z0-9_]*|PERL5OPT|RUBYOPT|HOME|PATH|XDG_[A-Z0-9_]+|RIPGREP_CONFIG_PATH|GH_CONFIG_DIR|GNUPGHOME|YARN_[A-Z0-9_]+|[Nn][Pp][Mm]_[Cc][Oo][Nn][Ff][Ii][Gg]_[A-Za-z0-9_]+)=/;

/** A command word with a directory part runs that file; only these system directories are trusted. */
const SYSTEM_BIN_DIRS = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]);

/** Characters after `$` that start an expansion: names, positional and special parameters, `${`, `$(`, `$[`. */
const DOLLAR_EXPANSION_START = /[A-Za-z0-9_{([@*#?$!-]/;

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

// yarn is absent on purpose: a repo `yarnPath` (.yarnrc.yml) or `yarn-path` (.yarnrc) makes every
// yarn command, `--version` included, run JavaScript from the repo.
const PACKAGE_MANAGER_READS = new Map<string, Set<string>>([
	["npm", new Set(["ls", "list", "view", "info", "explain", "outdated", "root", "prefix"])],
	["pnpm", new Set(["ls", "list", "why", "outdated"])],
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

/**
 * Commands where an option can write a file or run a program (sed -i, sort -o, file -C, find -delete,
 * rg --pre, git --output). An unquoted glob at the start of an argument can expand to a repo file
 * named like such an option (`sed s/a/b/ *.ts` with a file `-i.ts`), so those arguments block.
 */
const OPTION_GLOB_SENSITIVE = new Set(["sed", "sort", "file", "find", "rg", "git"]);

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

	// Substitutions, parameter expansion, ANSI-C quoting and brace expansion change
	// the words after this check, so a literal word check cannot classify them.
	if (hasShellExpansion(command)) return true;

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

/**
 * True when bash would rewrite a word before running it: command and process substitution,
 * `$` expansions (also inside double quotes), `$'…'`/`$"…"` quoting and `{a,b}`/`{a..b}` brace
 * expansion. Single quotes keep everything literal. A `$` that starts no expansion (`grep 'x$'`,
 * `grep "x$"`) stays allowed.
 */
function hasShellExpansion(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let braceDepth = 0;
	let braceList = false;
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
		if (quote === "'") {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "`") return true;
		if (ch === "$" && next !== undefined) {
			if (DOLLAR_EXPANSION_START.test(next)) return true;
			if (!quote && (next === "'" || next === '"')) return true;
		}
		if (quote === '"') {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if ((ch === "<" || ch === ">") && next === "(") return true;
		if (ch === "&" && next === ">") return true;
		if (ch === "{") {
			braceDepth++;
		} else if (ch === "}" && braceDepth > 0) {
			if (braceList) return true;
			braceDepth--;
		} else if (braceDepth > 0 && (ch === "," || (ch === "." && next === "."))) {
			braceList = true;
		} else if (/[\s;&|]/.test(ch)) {
			braceDepth = 0;
			braceList = false;
		}
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
			if (next === "\n") continue;
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

/**
 * Find unquoted glob characters (`*`, `?`, `[`) in a segment. `leading` is true when the literal
 * text before a word's first glob is empty or only dashes (`*`, `-*`, `""*`, `\-*`), so the word
 * could expand to a file name that is an option.
 */
function unquotedGlobs(segment: string): { any: boolean; leading: boolean } {
	let any = false;
	let quote: "'" | '"' | undefined;
	// Literal text of the current word so far, with quotes and escapes removed; undefined once the
	// word has had its first glob checked.
	let prefix: string | undefined = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && quote !== "'") {
			if (prefix !== undefined && i + 1 < segment.length) prefix += segment[i + 1];
			i++;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (prefix !== undefined) prefix += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			prefix = "";
			continue;
		}
		if (ch === "*" || ch === "?" || ch === "[") {
			if (prefix !== undefined && /^-*$/.test(prefix)) return { any: true, leading: true };
			any = true;
			prefix = undefined;
			continue;
		}
		if (prefix !== undefined) prefix += ch;
	}
	return { any, leading: false };
}

function isMutatingSegment(segment: string): boolean {
	let tokens = shellWords(segment);
	if (!tokens) return true;
	// Skip leading env assignments (FOO=bar cmd …) and command wrappers we can't see through.
	while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
		// Some variables make an informational command run another program (git's external diff, pagers, preloads).
		if (CODE_RUNNING_ENV.test(tokens[0])) return true;
		tokens = tokens.slice(1);
	}
	if (tokens.length === 0) return false;

	// `./scripts/ls` is a project file, not ls. Only bare names and trusted system paths count.
	const slash = tokens[0].lastIndexOf("/");
	if (tokens[0].includes("\\") || (slash >= 0 && !SYSTEM_BIN_DIRS.has(tokens[0].slice(0, slash)))) return true;

	const command = basenameOf(tokens[0]).toLowerCase();
	const args = tokens.slice(1);

	if (ALWAYS_MUTATING_MANAGERS.has(command)) return true;

	const globs = unquotedGlobs(segment);
	if (globs.leading && OPTION_GLOB_SENSITIVE.has(command)) return true;

	if (command === "sed") return isMutatingSed(args, globs.any);
	if (command === "date") return isSettingDate(args);
	if (command === "find") {
		return args.some((a) =>
			["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a),
		);
	}
	if (command === "rg") {
		// --pre runs a program on every searched file.
		return args.some((a) => a === "--pre" || a.startsWith("--pre="));
	}
	if (command === "uniq") {
		// uniq [options] [input [output]] writes the output operand; a glob can expand to two operands.
		return globs.any || args.filter((a) => !a.startsWith("-")).length >= 2;
	}
	if (command === "file") {
		// file -C / --compile writes a compiled .mgc magic file.
		return args.some((arg) => {
			const option = arg.split("=")[0];
			return (option.startsWith("--co") && "--compile".startsWith(option)) || /^-[^-]*C/.test(arg);
		});
	}
	if (command === "less" || command === "more") {
		// -k/--lesskey-file/--lesskey-src load a key file whose #env section can set LESSOPEN, which
		// runs a command even when output is not a terminal. -o/-O/--log-file write a log file.
		// Long options may be abbreviated, so any prefix of those names counts.
		return args.some((arg) => {
			const option = arg.split("=")[0].toLowerCase();
			return (
				/^-[^-]*[oOk]/.test(arg) ||
				(option.length >= 4 &&
					["--log-file", "--lesskey-file", "--lesskey-src", "--lesskey-content"].some((name) =>
						name.startsWith(option),
					))
			);
		});
	}
	if (command === "git") {
		// git grep -O/--open-files-in-pager runs a pager program on the matches.
		if (args.some((a) => /^-O/.test(a) || a.startsWith("--open-files-in-pager"))) return true;
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

/** sed options that change neither where the script comes from nor what sed writes. */
const SED_SAFE_SHORT = new Set("nErsuzb");
const SED_SAFE_LONG = new Set([
	"--quiet",
	"--silent",
	"--regexp-extended",
	"--separate",
	"--unbuffered",
	"--null-data",
	"--zero-terminated",
	"--posix",
	"--debug",
	"--sandbox",
	"--follow-symlinks",
	"--binary",
	"--help",
	"--version",
]);

/**
 * sed writes with -i, -f hides the script, and the script itself can write (w, W, s///w) or run
 * commands (e, s///e). Unknown or abbreviated options fail closed. GNU sed permutes options and
 * operands, so options count anywhere before `--`.
 */
function isMutatingSed(args: string[], hasGlob: boolean): boolean {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (arg === "--") {
			operands.push(...args.slice(k + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			const value = eq < 0 ? undefined : arg.slice(eq + 1);
			if (name === "--expression" || name === "--line-length") {
				const taken = value ?? args[++k];
				if (taken === undefined) return true;
				if (name === "--expression") scripts.push(taken);
			} else if (value !== undefined || !SED_SAFE_LONG.has(name)) {
				return true;
			}
			continue;
		}
		if (arg.length > 1 && arg.startsWith("-")) {
			for (let j = 1; j < arg.length; j++) {
				const flag = arg[j];
				if (flag === "e" || flag === "l") {
					const taken = arg.slice(j + 1) || args[++k];
					if (taken === undefined) return true;
					if (flag === "e") scripts.push(taken);
					break;
				}
				if (!SED_SAFE_SHORT.has(flag)) return true;
			}
			continue;
		}
		operands.push(arg);
	}
	if (scripts.length === 0) {
		if (operands[0] === undefined) return false;
		scripts.push(operands[0]);
	}
	// GNU sed joins -e scripts with newlines.
	const script = scripts.join("\n");
	// With an unquoted glob in the command, glob characters here may mean the script is a file name.
	if (hasGlob && /[*?[]/.test(script)) return true;
	return sedScriptWritesOrRuns(script);
}

/**
 * Walks a sed script with GNU sed's grammar. True when a command or `s` flag writes a file or runs a
 * command, and for anything the walk does not understand. `r` and `R` only read.
 */
function sedScriptWritesOrRuns(script: string): boolean {
	let i = 0;
	const fail = (): never => {
		throw new Error("unparsed sed script");
	};
	const skipWhile = (test: RegExp) => {
		while (i < script.length && test.test(script[i])) i++;
	};
	const skipToLineEnd = () => {
		while (i < script.length && script[i] !== "\n") i++;
	};
	// Up to and past the closing delimiter. A bracket expression may hold the delimiter.
	const skipRegex = (delim: string) => {
		for (;;) {
			const ch = script[i++];
			if (ch === undefined || ch === "\n") fail();
			if (ch === "\\") {
				if (script[i++] === undefined) fail();
			} else if (ch === delim) {
				return;
			} else if (ch === "[") {
				if (script[i] === "^") i++;
				if (script[i] === "]") i++;
				for (;;) {
					const inner = script[i++];
					// Escapes inside brackets differ between seds, so they fail closed.
					if (inner === undefined || inner === "\n" || inner === "\\") fail();
					if (inner === "]") break;
					if (inner === "[" && /[:.=]/.test(script[i] ?? "")) {
						const close = script.indexOf(`${script[i]}]`, i + 1);
						if (close < 0) fail();
						i = close + 2;
					}
				}
			}
		}
	};
	const skipText = (delim: string) => {
		for (;;) {
			const ch = script[i++];
			if (ch === undefined || ch === "\n") fail();
			if (ch === "\\") {
				if (script[i++] === undefined) fail();
			} else if (ch === delim) {
				return;
			}
		}
	};
	const delimiter = () => {
		const delim = script[i++];
		if (delim === undefined || delim === "\n" || delim === "\\" || delim === "[") fail();
		return delim;
	};
	const address = (): boolean => {
		const ch = script[i];
		if (ch === undefined) return false;
		if (/\d/.test(ch)) {
			skipWhile(/\d/);
			if (script[i] === "~") {
				i++;
				skipWhile(/\d/);
			}
		} else if (ch === "$") {
			i++;
		} else if (ch === "/" || ch === "\\") {
			i++;
			skipRegex(ch === "/" ? "/" : delimiter());
			skipWhile(/[IM]/);
		} else {
			return false;
		}
		return true;
	};
	const endCommand = () => {
		skipWhile(/[ \t]/);
		if (i < script.length && !/[;\n}]/.test(script[i])) fail();
	};
	try {
		while (i < script.length) {
			skipWhile(/[\s;]/);
			if (i >= script.length) break;
			if (script[i] === "#") {
				skipToLineEnd();
				continue;
			}
			if (address()) {
				skipWhile(/[ \t]/);
				if (script[i] === ",") {
					i++;
					skipWhile(/[ \t]/);
					if (/[+~]/.test(script[i] ?? "")) {
						i++;
						if (!/\d/.test(script[i] ?? "")) fail();
						skipWhile(/\d/);
					} else if (!address()) {
						fail();
					}
				}
			}
			skipWhile(/[ \t!]/);
			const command = script[i++];
			switch (command) {
				case "{":
				case "}":
					break;
				case "=":
				case "d":
				case "D":
				case "g":
				case "G":
				case "h":
				case "H":
				case "n":
				case "N":
				case "p":
				case "P":
				case "x":
				case "z":
				case "F":
					endCommand();
					break;
				case "l":
				case "q":
				case "Q":
					skipWhile(/[ \t]/);
					skipWhile(/\d/);
					endCommand();
					break;
				case ":":
				case "b":
				case "t":
				case "T":
				case "v":
					while (i < script.length && !/[;\n]/.test(script[i])) i++;
					break;
				case "a":
				case "i":
				case "c":
					// Text runs to the first unescaped newline.
					while (i < script.length && script[i] !== "\n") i += script[i] === "\\" ? 2 : 1;
					break;
				case "r":
				case "R":
					skipToLineEnd();
					break;
				case "s": {
					const delim = delimiter();
					skipRegex(delim);
					skipText(delim);
					skipWhile(/[gpiImM\d]/);
					if (script[i] === "w" || script[i] === "e") return true;
					endCommand();
					break;
				}
				case "y": {
					const delim = delimiter();
					skipText(delim);
					skipText(delim);
					endCommand();
					break;
				}
				default:
					// w, W and e write or run; anything else is not understood.
					return true;
			}
		}
	} catch {
		return true;
	}
	return false;
}

/**
 * `date` sets the system clock with -s/--set or a bare MMDDhhmm operand. Only display forms are
 * allowed: +FORMAT, -u, -R, -I, --debug and the -d/-r inputs.
 */
function isSettingDate(args: string[]): boolean {
	for (let k = 0; k < args.length; k++) {
		const arg = args[k];
		if (arg === "-d" || arg === "-r" || arg === "--date" || arg === "--reference") {
			k++;
			continue;
		}
		const display =
			arg.startsWith("+") ||
			/^-(?:u|R|I\w*|[dr].+)$/.test(arg) ||
			/^--(?:utc|universal|rfc-email|debug|iso-8601(?:=\w+)?|rfc-3339=\w+|date=.*|reference=.*)$/s.test(arg);
		if (!display) return true;
	}
	return false;
}

/**
 * Global git options that take no value. Unknown leading flags are treated as mutating, including
 * `-C`, `--git-dir`, `--work-tree` and `--bare`: they can point git at a repository whose config
 * (core.fsmonitor, diff.external, textconv) runs a program.
 */
const GIT_GLOBAL_FLAGS = new Set([
	"--no-pager",
	"--version",
	"--help",
	"-h",
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
		if (token === "--namespace") {
			if (args[index + 1] === undefined) return -1;
			index += 2;
			continue;
		}
		if (token.startsWith("--namespace=")) {
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
