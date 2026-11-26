/**
 * lunR: auto mode's local rules. Bash commands that only create, copy, move, write or delete named
 * ordinary files inside the project, and `write` calls to ordinary project files, run without a
 * review request. Anything this module can't prove harmless goes to the reviewer as before. The
 * rules are the table under "Auto review" in docs/agents/permissions-and-memory.md.
 *
 * Commands are read with `deniedCommandLines`, the parser deny rules use, and lines that only read
 * are classified by read-only mode's `isMutatingBashCommand`. Only the path rules and the option
 * tables of the write commands live here.
 */

import { execFile } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { type DeniedLine, deniedCommandLines } from "./permission-rule-commands.ts";
import { isMutatingBashCommand } from "./plan-mode.ts";
import { protectedTargetWriteReason } from "./protected-targets.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/** Options a write command may carry: clusterable single letters and exact long options. None takes a value. */
const WRITE_COMMANDS = new Map<string, { short: string; long: readonly string[]; minOperands: number }>([
	["mkdir", { short: "pv", long: ["--parents", "--verbose"], minOperands: 1 }],
	["touch", { short: "acm", long: ["--no-create"], minOperands: 1 }],
	[
		"cp",
		{
			short: "rRapfnvu",
			long: ["--recursive", "--archive", "--force", "--no-clobber", "--verbose", "--update"],
			minOperands: 2,
		},
	],
	["mv", { short: "fnvu", long: ["--force", "--no-clobber", "--verbose", "--update"], minOperands: 2 }],
	["rm", { short: "fv", long: ["--force", "--verbose"], minOperands: 1 }],
]);
/** `sed -i` options besides `-i` itself; `-e` takes the next word as the script. */
const SED_IN_PLACE_OPTIONS = new Set(["-E", "-r", "-n", "-e"]);
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
}

/**
 * Auto mode's local allow rules for one session. `allows` runs before the review step on every
 * auto-mode tool call; it remembers the files the session's allowed commands created, so `rm` of
 * those runs without review too.
 */
export class AutoReviewSkips {
	private created = new Set<string>();
	private roots = new Map<string, Project | undefined>();

	/** True when the call can run without a review request. False means "review as before". */
	async allows(toolName: string, input: Record<string, unknown>, cwd: string): Promise<boolean> {
		if (toolName === "write") return this.allowsWrite(input.path, cwd);
		if (toolName !== "bash" || typeof input.command !== "string") return false;
		const project = this.project(cwd);
		if (!project) return false;
		const effects = this.bashEffects(input.command, project);
		if (!effects) return false;
		if (effects.replaced.length > 0 && !(await trackedAndClean(effects.replaced, project.root))) return false;
		for (const path of effects.created) this.created.add(path);
		for (const [from, to] of effects.moved) {
			this.created.delete(from);
			this.created.add(to);
		}
		return true;
	}

	/** Same rule as `needsAutoReview` for `write`; records a new file so a later `rm` of it can skip review. */
	private allowsWrite(path: unknown, cwd: string): boolean {
		const project = this.project(cwd);
		if (typeof path !== "string" || !project) return false;
		// Resolved the way the file tools resolve it (`~`, `@`, `file://`).
		const target = ordinaryTarget(resolveToCwd(path, cwd), project);
		if (!target) return false;
		if (!exists(target)) this.created.add(target);
		return true;
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
		const effects: Effects = { created: [], moved: [], renamed: [], replaced: [] };
		for (const { op, target } of parsed.redirects) {
			if (op === "<" || op === "<<<") continue;
			if ((op === ">&" || op === "<&") && FD_DUPLICATE.test(target)) continue;
			if (!op.includes(">")) return undefined;
			if (target === "/dev/null") continue;
			const path = projectPath(target, project);
			// `>>` only appends, so the old content stays.
			if (!path || !this.writes(path, op.endsWith(">>") ? "append" : "write", effects)) return undefined;
		}
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
			const files = sedInPlaceFiles(args, project);
			return files ? files.every((path) => this.writes(path, "write", effects)) : !isMutatingLine(name, args);
		}
		const spec = WRITE_COMMANDS.get(name);
		// `cd` is read-only, but it moves every later path out of the checks below.
		if (!spec) return name !== "cd" && name !== "pushd" && !isMutatingLine(name, args);

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
			for (const path of paths) if (!exists(path)) effects.created.push(path);
		} else if (name === "cp" || name === "mv") {
			const destination = paths[paths.length - 1];
			const intoDirectory = isDirectory(destination);
			if (paths.length > 2 && !intoDirectory) return false;
			for (const source of paths.slice(0, -1)) {
				const to = intoDirectory ? join(destination, basename(source)) : destination;
				// Onto an existing directory, cp merges and mv replaces it: more than the command names.
				if (name === "cp" && !this.writes(to, "write", effects)) return false;
				if (name === "mv") {
					if (!this.writes(to, "move", effects)) return false;
					if (this.created.has(source)) effects.moved.push([source, to]);
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
				if (named.isSymbolicLink() || named.isDirectory()) return false;
				if (!this.created.has(path)) effects.replaced.push(path);
			}
		}
		return true;
	}

	/**
	 * Notes a write to `path` in `effects`; false when `path` is a directory. A new path counts as
	 * created unless `mv` put an existing file there.
	 */
	private writes(path: string, mode: "write" | "append" | "move", effects: Effects): boolean {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) {
			if (mode !== "move") effects.created.push(path);
		} else if (stat.isDirectory()) return false;
		else if (mode !== "append" && !this.created.has(path)) effects.replaced.push(path);
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

/** The files of `sed -i [-E|-r|-n] [-e script | script] file...` when its script only edits, else undefined. */
function sedInPlaceFiles(args: string[], project: Project): string[] | undefined {
	const rest: string[] = [];
	let inPlace = false;
	let script = false;
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (word === "-i" || word === "--in-place") {
			inPlace = true;
			continue;
		}
		rest.push(word);
		if (!word.startsWith("-")) {
			if (script) operands.push(word);
			script = true;
		} else if (!SED_IN_PLACE_OPTIONS.has(word)) return undefined;
		else if (word === "-e") {
			if (i + 1 >= args.length) return undefined;
			rest.push(args[++i]);
			script = true;
		}
	}
	// The same sed script check read-only mode runs, with `-i` taken out: no `w`, `e` or `-f`.
	if (!inPlace || operands.length === 0 || isMutatingLine("sed", rest)) return undefined;
	const files: string[] = [];
	for (const word of operands) {
		const path = projectPath(word, project);
		if (!path || !exists(path)) return undefined;
		files.push(path);
	}
	return files;
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
 * True when git reports every path as tracked with no uncommitted change, so deleting it loses
 * nothing git can't restore. fsmonitor is off so the check runs no configured program.
 */
function trackedAndClean(paths: readonly string[], root: string): Promise<boolean> {
	const args = ["-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain", "-z"];
	args.push("--ignored=matching", "--untracked-files=all", "--", ...paths.map((path) => relative(root, path)));
	return new Promise((done) => {
		execFile("git", args, { cwd: root, timeout: GIT_TIMEOUT_MS }, (error, stdout) => done(!error && stdout === ""));
	});
}
