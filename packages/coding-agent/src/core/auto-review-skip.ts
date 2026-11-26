/**
 * lunR: auto mode's local rules. Bash commands that only create, copy, move, write or delete named
 * regular files inside the project, and `write` calls to ordinary project files, run without a
 * review request. Anything this module can't prove harmless goes to the reviewer as before. The
 * rules are the table under "Auto review" in docs/agents/permissions-and-memory.md.
 *
 * Commands are read with `deniedCommandLines`, the parser deny rules use, and lines that only read
 * are classified by read-only mode's `isMutatingBashCommand` and `sedScriptReads`. Only the path
 * rules and the option tables of the write commands live here.
 *
 * Paths are checked against the filesystem before the command runs. That holds for the whole line
 * because no allowed command creates a symlink: `cp` and `mv` take only regular-file sources and
 * no recursive option, so the only new entries a later part resolves through are real directories
 * made by `mkdir` inside the project.
 */

import { execFile } from "node:child_process";
import { lstatSync, realpathSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { type DeniedLine, deniedCommandLines } from "./permission-rule-commands.ts";
import { isMutatingBashCommand, sedScriptReads } from "./plan-mode.ts";
import { protectedTargetWriteReason } from "./protected-targets.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/** Options a write command may carry: clusterable single letters and exact long options. None takes a value. */
const WRITE_COMMANDS = new Map<string, { short: string; long: readonly string[]; minOperands: number }>([
	["mkdir", { short: "pv", long: ["--parents", "--verbose"], minOperands: 1 }],
	["touch", { short: "acm", long: ["--no-create"], minOperands: 1 }],
	// No -r, -R or -a: a copied tree can carry a symlink that a later part of the line writes through.
	["cp", { short: "pfnvu", long: ["--force", "--no-clobber", "--verbose", "--update"], minOperands: 2 }],
	["mv", { short: "fnvu", long: ["--force", "--no-clobber", "--verbose", "--update"], minOperands: 2 }],
	["rm", { short: "fv", long: ["--force", "--verbose"], minOperands: 1 }],
]);
/** sed options this module reads; `-e` takes the next word as a script. */
const SED_OPTIONS = new Set(["-i", "--in-place", "-E", "-r", "-n", "-e"]);
/**
 * Commands that may feed a redirect into a project file: they read only the files they name, or
 * print only their literal arguments. `printenv`, `env` and the rest of read-only mode's list stay
 * reviewed there, since they can copy the environment or files outside the project into it.
 */
const REDIRECT_SOURCES = new Map<string, "files" | "literal">([
	...["cat", "tac", "head", "tail", "grep", "sort", "uniq", "wc", "cut", "tr", "nl", "diff", "ls", "sed"].map(
		(name) => [name, "files"] as const,
	),
	...["echo", "printf", "true"].map((name) => [name, "literal"] as const),
]);
/** Bash expands these in an unquoted word, and the parser has already dropped the quotes. */
const EXPANDING_WORD = /[*?[\]{}\u0001]|^~/;
const FD_DUPLICATE = /^(?:\d+|-)$/;
const GIT_TIMEOUT_MS = 2000;

interface Project {
	/** The canonical project directory. */
	root: string;
	/** The session directory commands start in. */
	cwd: string;
	/** The project overlaps lunR's profile directory, so paths are checked against `protected-targets.ts`. */
	checkProtected: boolean;
}

/** What lets a file count as made by this session: it must still be the same file. */
interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

/** What an allowed command does to the files this module tracks. */
interface Effects {
	/** Paths that don't exist yet and may be created. */
	created: string[];
	/** `mv` of a file this session created: the old path and the new one. */
	moved: Array<[from: string, to: string]>;
	/** Where `mv` puts files the session didn't create, so an `rm` later in the same command is reviewed. */
	renamed: string[];
	/**
	 * Existing files the command deletes or replaces (`rm`, `>`, `cp`/`mv` onto them, `sed -i`) that this
	 * session didn't create. Rollback covers only the file tools, so git must be able to restore these.
	 */
	replaced: string[];
	/** Some redirect writes a project file, so every other part must read only project files. */
	redirectsOutput: boolean;
}

/**
 * Auto mode's local allow rules for one session. `allows` runs before the review step on every
 * auto-mode tool call, and `finished` after the call. Files an allowed call created are remembered
 * once it succeeded, with their identity, so a later `rm` or overwrite of the same file runs without
 * review too.
 */
export class AutoReviewSkips {
	private created = new Map<string, FileIdentity>();
	/** What each allowed call will create, recorded by `finished` once the call succeeded. */
	private pending = new Map<string, Pick<Effects, "created" | "moved">>();
	private roots = new Map<string, Project | undefined>();

	/**
	 * True when the call can run without a review request. False means "review as before".
	 * `shellCommandPrefix` is the bash prefix setting: it can change what every checked path means.
	 */
	async allows(
		toolName: string,
		input: Record<string, unknown>,
		cwd: string,
		call: { id: string; shellCommandPrefix?: string },
	): Promise<boolean> {
		if (toolName === "write" || toolName === "edit") return this.allowsFileTool(input.path, cwd, call.id);
		if (toolName !== "bash" || typeof input.command !== "string" || call.shellCommandPrefix) return false;
		const project = this.project(cwd);
		if (!project) return false;
		const effects = this.bashEffects(input.command, project);
		if (!effects) return false;
		if (effects.replaced.length > 0 && !(await gitCanRestore(effects.replaced, project.root))) return false;
		this.expect(call.id, effects);
		return true;
	}

	/** Records the files an allowed call created, when it succeeded and they are still regular files. */
	finished(toolCallId: string, isError: boolean): void {
		const effects = this.pending.get(toolCallId);
		if (!effects) return;
		this.pending.delete(toolCallId);
		if (isError) return;
		for (const [from, to] of effects.moved) {
			this.created.delete(from);
			this.remember(to);
		}
		for (const path of effects.created) this.remember(path);
	}

	/**
	 * Same rule as `needsAutoReview` for `write` and `edit`. A file the call creates, or a session file
	 * it changes, counts as made by the session once the call succeeded.
	 */
	private allowsFileTool(path: unknown, cwd: string, toolCallId: string): boolean {
		const project = this.project(cwd);
		if (typeof path !== "string" || !project) return false;
		// Resolved the way the file tools resolve it (`~`, `@`, `file://`).
		const target = ordinaryTarget(resolveToCwd(path, cwd), project);
		if (!target) return false;
		const stat = lstatSync(target, { throwIfNoEntry: false });
		if (!stat || this.madeHere(target, stat)) this.expect(toolCallId, { created: [target], moved: [] });
		return true;
	}

	private expect(toolCallId: string, { created, moved }: Pick<Effects, "created" | "moved">): void {
		if (created.length === 0 && moved.length === 0) return;
		// A call a later gate blocked never finishes; drop the oldest so the map stays small.
		if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value ?? "");
		this.pending.set(toolCallId, { created, moved });
	}

	private remember(path: string): void {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat?.isFile() && stat.nlink === 1) {
			this.created.set(path, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
		} else this.created.delete(path);
	}

	/** True when `path` is a file this session made and nothing changed it since. */
	private madeHere(path: string, stat: Stats): boolean {
		const known = this.created.get(path);
		return (
			known !== undefined &&
			known.dev === stat.dev &&
			known.ino === stat.ino &&
			known.size === stat.size &&
			known.mtimeMs === stat.mtimeMs
		);
	}

	/** The project for `cwd`, or undefined when `cwd` is the home or root directory. */
	project(cwd: string): Project | undefined {
		const agentDir = getAgentDir();
		const key = `${cwd}\0${agentDir}`;
		if (this.roots.has(key)) return this.roots.get(key);
		const root = canonical(cwd);
		let project: Project | undefined;
		if (root && dirname(root) !== root && root !== canonical(homedir())) {
			// Every protected target lives under the profile's parent (`~/.lunr`) or the project's `.lunr`,
			// which the hidden-path rule already covers, so the costly check runs only when they overlap.
			const profile = canonical(dirname(agentDir)) ?? dirname(agentDir);
			project = { root, cwd, checkProtected: isWithin(profile, root) || isWithin(root, profile) };
		}
		this.roots.set(key, project);
		return project;
	}

	/** What `command` does, or undefined when any part of it needs review. */
	bashEffects(command: string, project: Project): Effects | undefined {
		// Variables, command substitution and `$'…'` can produce any word, also inside a here-document.
		if (command.includes("$") || command.includes("`")) return undefined;
		const parsed = deniedCommandLines(command, 64 * command.length);
		if (parsed.uncheckable || parsed.wildcard || parsed.assigns || parsed.lines.length === 0) return undefined;
		const effects: Effects = { created: [], moved: [], renamed: [], replaced: [], redirectsOutput: false };
		const inputs: string[] = [];
		for (const { op, target } of parsed.redirects) {
			if (op === "<<<") continue;
			if ((op === ">&" || op === "<&") && FD_DUPLICATE.test(target)) continue;
			if (op === "<") {
				inputs.push(target);
				continue;
			}
			if (!op.includes(">")) return undefined;
			if (target === "/dev/null") continue;
			const path = projectPath(target, project);
			// `>>` only appends, so the old content stays.
			if (!path || !this.writes(path, op.endsWith(">>") ? "append" : "write", effects)) return undefined;
			effects.redirectsOutput = true;
		}
		// What goes into a project file must come from the project too.
		if (effects.redirectsOutput && !inputs.every((target) => projectPath(target, project))) return undefined;
		for (const line of parsed.lines) {
			if (!this.lineEffects(line, project, effects)) return undefined;
		}
		return effects;
	}

	private lineEffects(line: DeniedLine, project: Project, effects: Effects): boolean {
		const { words, start, end, name } = line;
		// `./touch` or `/tmp/x/touch` is another program with a familiar name.
		if (words[start] !== name) return false;
		const args = words.slice(start + 1, end);
		if (args.some((word) => EXPANDING_WORD.test(word))) return false;
		if (name === "sed") {
			const sed = sedCall(args, project);
			if (sed?.inPlace) return sed.files.every((path) => this.writes(path, "write", effects));
			if (effects.redirectsOutput && !sed) return false;
			return !isMutatingLine(name, args);
		}
		const spec = WRITE_COMMANDS.get(name);
		if (!spec) {
			// `cd` is read-only, but it moves every later path out of the checks below.
			if (name === "cd" || name === "pushd" || isMutatingLine(name, args)) return false;
			return !effects.redirectsOutput || readsOnlyProject(name, args, project);
		}

		const operands: string[] = [];
		let optionsEnded = false;
		for (const word of args) {
			if (!optionsEnded && word === "--") optionsEnded = true;
			else if (!optionsEnded && word.startsWith("--")) {
				if (!spec.long.includes(word)) return false;
			} else if (!optionsEnded && word.startsWith("-") && word.length > 1) {
				for (const letter of word.slice(1)) if (!spec.short.includes(letter)) return false;
			} else operands.push(word);
		}
		if (operands.length < spec.minOperands) return false;
		const paths: string[] = [];
		for (const word of operands) {
			const path = projectPath(word, project);
			if (!path) return false;
			paths.push(path);
		}

		if (name === "mkdir" || name === "touch") {
			for (const path of paths) {
				const stat = lstatSync(path, { throwIfNoEntry: false });
				// `touch` on a second hard link or a device changes something that may not be in the project.
				if (stat && !stat.isDirectory() && (!stat.isFile() || stat.nlink > 1)) return false;
				if (!stat || (stat.isFile() && this.madeHere(path, stat))) effects.created.push(path);
			}
		} else if (name === "cp" || name === "mv") {
			const destination = paths[paths.length - 1];
			const intoDirectory = isDirectory(destination);
			if (paths.length > 2 && !intoDirectory) return false;
			// Only regular files move or copy: a directory or symlink could bring a link out of the project.
			for (const word of operands.slice(0, -1)) {
				if (!lstatSync(resolve(project.cwd, word), { throwIfNoEntry: false })?.isFile()) return false;
			}
			for (const source of paths.slice(0, -1)) {
				const to = intoDirectory ? join(destination, basename(source)) : destination;
				// Onto an existing directory, cp merges and mv replaces it: more than the command names.
				if (name === "cp" && !this.writes(to, "write", effects)) return false;
				if (name === "mv") {
					if (!this.writes(to, "move", effects)) return false;
					const stat = lstatSync(source, { throwIfNoEntry: false });
					if (stat && this.madeHere(source, stat)) effects.moved.push([source, to]);
					else effects.renamed.push(to);
				}
			}
		} else {
			for (const [index, path] of paths.entries()) {
				// rm deletes the link itself, while `path` is where it points.
				const named = lstatSync(resolve(project.cwd, operands[index]), { throwIfNoEntry: false });
				if (!named) {
					if (effects.renamed.includes(path)) return false;
					continue;
				}
				// A second hard link keeps the data, possibly outside the project; anything but a file isn't ours.
				if (!named.isFile() || named.nlink > 1) return false;
				if (!this.madeHere(path, named)) effects.replaced.push(path);
			}
		}
		return true;
	}

	/**
	 * Notes a write to `path` in `effects`. False unless `path` is new or a regular file with one link:
	 * a FIFO blocks the write, and a second hard link may be a file outside the project. A new path
	 * counts as created unless `mv` put an existing file there.
	 */
	private writes(path: string, mode: "write" | "append" | "move", effects: Effects): boolean {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) {
			if (mode !== "move") effects.created.push(path);
			return true;
		}
		if (!stat.isFile() || stat.nlink > 1) return false;
		const mine = this.madeHere(path, stat);
		if (!mine && mode !== "append") effects.replaced.push(path);
		// Still the session's file afterwards, with a new size and time; not so when `mv` moved another file here.
		if (mine && mode !== "move") effects.created.push(path);
		return true;
	}
}

/**
 * The canonical path `word` names when it is an ordinary file inside `root`: not hidden, not a
 * protected target, and not reached through a symlink that leaves the project.
 */
function projectPath(word: string, project: Project): string | undefined {
	// A backslash left after parsing was quoted: a literal on POSIX, a separator on Windows.
	if (word === "" || word.includes("\\") || EXPANDING_WORD.test(word)) return undefined;
	return ordinaryTarget(resolve(project.cwd, word), project);
}

/** The canonical form of the absolute `path` when it is an ordinary project file (see `projectPath`). */
function ordinaryTarget(path: string, project: Project): string | undefined {
	const target = canonical(path, project);
	if (!target) return undefined;
	const rel = relative(project.root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	if (rel.split(sep).some((segment) => segment.startsWith("."))) return undefined;
	return project.checkProtected && protectedTargetWriteReason(target, project.cwd) ? undefined : target;
}

/**
 * `canonicalizeTargetPath` without its exceptions, which cost tens of microseconds for each missing
 * component: the real path of the deepest existing ancestor plus the rest. Undefined for a dangling
 * link or an unreadable path. The session directory resolves to the project root it was resolved to
 * at the session's first call, which saves a `realpath` for new files.
 */
function canonical(path: string, project?: Project): string | undefined {
	const suffix: string[] = [];
	for (let ancestor = path; ; ancestor = dirname(ancestor)) {
		if (ancestor === project?.cwd) return join(project.root, ...suffix);
		if (lstatSync(ancestor, { throwIfNoEntry: false })) {
			try {
				return join(realpathSync.native(ancestor), ...suffix);
			} catch {
				return undefined;
			}
		}
		if (dirname(ancestor) === ancestor) return undefined;
		suffix.unshift(basename(ancestor));
	}
}

function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `sed [-i] [-E|-r|-n] [-e script]... [script] file...` when every script passes read-only mode's sed
 * check (no `w`, `e` or `-f`) with `-i` taken out, and every file, including those `r` and `R` read,
 * is an existing project file. Undefined for anything else.
 */
function sedCall(args: string[], project: Project): { inPlace: boolean; files: string[] } | undefined {
	let inPlace = false;
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "-i" || word === "--in-place") inPlace = true;
		else if (word === "-e") {
			if (i + 1 >= args.length) return undefined;
			scripts.push(args[++i]);
		} else if (word.startsWith("-")) {
			if (!SED_OPTIONS.has(word)) return undefined;
		} else operands.push(word);
	}
	if (scripts.length === 0) {
		const script = operands.shift();
		if (script === undefined) return undefined;
		scripts.push(script);
	}
	if (operands.length === 0) return undefined;
	const reads: string[] = [];
	for (const script of scripts) {
		const read = sedScriptReads(script);
		if (!read) return undefined;
		reads.push(...read);
	}
	if (!reads.every((word) => projectPath(word, project))) return undefined;
	const files: string[] = [];
	for (const word of operands) {
		const path = projectPath(word, project);
		if (!path || !exists(path)) return undefined;
		files.push(path);
	}
	return { inPlace, files };
}

/**
 * True when a read-only line can feed a redirect into a project file: a command from
 * `REDIRECT_SOURCES` whose operands are all project paths and whose options name no path.
 */
function readsOnlyProject(name: string, args: readonly string[], project: Project): boolean {
	const kind = REDIRECT_SOURCES.get(name);
	if (kind === "literal") return true;
	if (!kind) return false;
	return args.every((word) => (word.startsWith("-") ? !word.includes("/") : projectPath(word, project) !== undefined));
}

/** Read-only mode's verdict on one command whose words are literal (no expansions left). */
function isMutatingLine(name: string, args: readonly string[]): boolean {
	return isMutatingBashCommand([name, ...args].map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" "));
}

function exists(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * True when git can restore every path: `git ls-files` lists it in this repository's index as a
 * regular blob at stage 0 with no skip-worktree or assume-unchanged flag (so not in a submodule or
 * a nested repository), and `git status` shows no change, staged or not. fsmonitor is off so the
 * check runs no configured program.
 */
async function gitCanRestore(paths: readonly string[], root: string): Promise<boolean> {
	const names = paths.map((path) => relative(root, path).split(sep).join("/"));
	const [listed, status] = await Promise.all([
		git(root, ["ls-files", "-s", "-v", "-z", "--", ...names]),
		git(root, ["status", "--porcelain", "-z", "--ignored=matching", "--untracked-files=all", "--", ...names]),
	]);
	if (listed === undefined || status !== "") return false;
	const restorable = new Set<string>();
	for (const record of listed.split("\0")) {
		if (!record) continue;
		// `H` is a plain cached entry; `S`, `h` and other tags mark flags that hide changes from status.
		const match = /^H (100644|100755) [0-9a-f]+ 0\t(.*)$/s.exec(record);
		if (!match) return false;
		restorable.add(match[2]);
	}
	return names.every((name) => restorable.has(name));
}

/** Runs git in `root` without optional locks, fsmonitor or pathspec magic; undefined on any failure. */
function git(root: string, args: string[]): Promise<string | undefined> {
	const options = ["-c", "core.fsmonitor=false", "--no-optional-locks", "--literal-pathspecs"];
	return new Promise((done) => {
		execFile("git", [...options, ...args], { cwd: root, timeout: GIT_TIMEOUT_MS }, (error, stdout) =>
			done(error ? undefined : stdout),
		);
	});
}
