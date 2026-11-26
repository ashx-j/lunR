/**
 * lunR: auto mode's local rules. A bash line skips the review request only when this module
 * understands all of it: literal words, a few commands with listed options, paths that stay inside
 * the project without `..`, hidden names or symlinks, and changes only to files this session made
 * or git proves unchanged. Anything else, and any error while deciding, goes to the reviewer. The
 * rules are the table under "Auto review" in docs/agents/permissions-and-memory.md.
 *
 * `lex` accepts a small grammar and refuses the rest instead of parsing bash: words of unquoted
 * `[A-Za-z0-9_./,:=+%@^-]`, single-quoted text and double-quoted text without `$`, backtick, `\`
 * or `!`; parts joined by `&&`, `;` or a newline; the redirects `>`, `>>`, `2>`, `2>>`, `2>&1`,
 * `>&2`, `<` and a here-document with a quoted marker. No allowed part can create a symlink, and
 * every path is read component by component with `lstat`, so the text and the disk can't disagree
 * about where a path leads. Later parts of a line are checked against what earlier parts did
 * (`Plan.overlay`).
 */

import { execFile } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "../config.ts";
import { getShellEnv } from "../utils/shell.ts";
import { isMutatingBashCommand, sedScriptReads } from "./plan-mode.ts";
import { protectedTargetWriteReason } from "./protected-targets.ts";
import { resolveToCwd } from "./tools/path-utils.ts";

/** Longer lines go to the reviewer unread, so the synchronous checks stay well under a millisecond. */
const MAX_COMMAND_LENGTH = 4096;
const MAX_PATHS = 64;
const GIT_TIMEOUT_MS = 2000;

/** The only options each command may carry: single letters may be combined (`-pv`), long ones are exact. */
const OPTIONS: Readonly<Record<string, { short: string; long: readonly string[] }>> = {
	mkdir: { short: "pv", long: ["--parents", "--verbose"] },
	touch: { short: "acm", long: ["--no-create"] },
	cp: { short: "fnpv", long: ["--force", "--no-clobber", "--verbose"] },
	mv: { short: "fnv", long: ["--force", "--no-clobber", "--verbose"] },
	rm: { short: "fv", long: ["--force", "--verbose"] },
	echo: { short: "neE", long: [] },
	cat: { short: "nbsAETv", long: [] },
	printf: { short: "", long: [] },
};
/** The only commands whose output may go into a project file without review. */
const OUTPUT_COMMANDS = new Set(["echo", "printf", "cat"]);
const UNQUOTED = /[A-Za-z0-9_./,:=+%@^-]/;
const HEREDOC_MARKER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type RedirectOp = ">" | ">>" | "2>" | "2>>" | "<" | "2>&1" | ">&2";

type Token =
	| { kind: "word"; text: string }
	| { kind: "op"; text: "&&" | ";" }
	| { kind: "redirect"; text: RedirectOp }
	| { kind: "heredoc" };

interface Part {
	name: string;
	args: string[];
	redirects: Array<{ op: RedirectOp; target?: string }>;
	heredoc: boolean;
}

/** A file this session made: it counts as the session's only while it is still the same file. */
interface FileIdentity {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

interface Project {
	/** The session directory, which is the project. */
	cwd: string;
	/** The project overlaps lunR's profile directory, so paths are checked against `protected-targets.ts`. */
	checkProtected: boolean;
}

/** What a path is after the parts of the line before it. `stat` is set when that comes from the disk. */
interface Resolved {
	path: string;
	state: "missing" | "dir" | "file";
	stat?: Stats;
}

/** What the line will do, as far as later parts and the session record need it. */
interface Plan {
	/** Earlier parts' results: a new directory, a file this line may change freely, or a removed path. */
	overlay: Map<string, "dir" | "mine" | "gone">;
	/** Existing files the line changes or removes that the session didn't make: git must prove them. */
	needProof: string[];
	/** Files to record as the session's once the call succeeded. */
	record: string[];
	/** Session files the line moves away or removes. */
	forget: string[];
	/** The line changes a file that already exists. */
	changesExisting: boolean;
}

/** Facts about the call that change what a command line means or when it runs. */
export interface SkipCall {
	id: string;
	/** The `shellCommandPrefix` setting: it runs before every command. */
	shellCommandPrefix?: string;
	/** The `shellPath` setting: another shell may read its own startup files. */
	shellPath?: string;
	/** A background bash job of this session is running and may change files at any moment. */
	backgroundJobs?: boolean;
}

/**
 * Auto mode's local allow rules for one session. `allows` runs before the review step on every
 * auto-mode tool call, and `finished` after the call, so files an allowed call created count as the
 * session's once it succeeded.
 */
export class AutoReviewSkips {
	private created = new Map<string, FileIdentity>();
	/** What each allowed call will record, applied by `finished` once the call succeeded. */
	private pending = new Map<string, Pick<Plan, "record" | "forget">>();
	private projects = new Map<string, Project | undefined>();

	/** True when the call can run without a review request. False means "review as before", also on any error. */
	async allows(toolName: string, input: Record<string, unknown>, cwd: string, call: SkipCall): Promise<boolean> {
		try {
			if (toolName === "write" || toolName === "edit") return this.allowsFileTool(input.path, cwd, call.id);
			if (toolName !== "bash" || typeof input.command !== "string" || input.run_in_background === true) return false;
			if (call.shellCommandPrefix || call.shellPath) return false;
			const project = this.project(cwd);
			if (!project) return false;
			const plan = this.plan(input.command, project);
			if (!plan) return false;
			// A running job can change any existing file between this check and the command.
			if (plan.changesExisting && call.backgroundJobs) return false;
			if (plan.needProof.length > 0 && !(await gitUnchanged(plan.needProof, project.cwd))) return false;
			this.expect(call.id, plan);
			return true;
		} catch {
			return false;
		}
	}

	/** Records what an allowed call created, once it succeeded and the files are still single regular files. */
	finished(toolCallId: string, isError: boolean): void {
		const plan = this.pending.get(toolCallId);
		if (!plan) return;
		this.pending.delete(toolCallId);
		if (isError) return;
		for (const path of plan.forget) this.created.delete(path);
		for (const path of plan.record) {
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat?.isFile() && stat.nlink === 1) {
				this.created.set(path, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
			} else this.created.delete(path);
		}
	}

	/**
	 * Decides nothing for `write` and `edit` (`needsAutoReview` does), but a file the call creates, or a
	 * session file it changes, counts as the session's once the call succeeded.
	 */
	private allowsFileTool(path: unknown, cwd: string, toolCallId: string): boolean {
		const project = this.project(cwd);
		if (typeof path !== "string" || !project) return false;
		// Resolved the way the file tools resolve it (`~`, `@`, `file://`), then held to the bash path rule.
		const rel = relative(project.cwd, resolveToCwd(path, cwd));
		if (rel.startsWith("..") || isAbsolute(rel)) return false;
		const target = resolvePath(rel, project, new Map());
		if (target?.state === "missing" || (target?.stat && this.madeHere(target.path, target.stat))) {
			this.expect(toolCallId, { record: [target.path], forget: [] });
		}
		return false;
	}

	/** The project for `cwd`, or undefined when `cwd` is `/` or home, or the shell could run other commands there. */
	project(cwd: string): Project | undefined {
		const env = getShellEnv();
		const agentDir = getAgentDir();
		const key = `${cwd}\0${agentDir}\0${env.PATH ?? ""}`;
		if (this.projects.has(key)) return this.projects.get(key);
		const root = resolve(cwd);
		// `BASH_ENV` and exported functions can redefine any command name for `bash -c`.
		const redefined = env.BASH_ENV || Object.keys(env).some((name) => name.startsWith("BASH_FUNC_"));
		// A relative or in-project `PATH` entry would let a project file stand in for `mkdir` or `cat`.
		const pathInProject = (env.PATH ?? "")
			.split(delimiter)
			.some((entry) => !isAbsolute(entry) || isWithin(resolve(entry), root));
		let project: Project | undefined;
		if (dirname(root) !== root && root !== resolve(homedir()) && !redefined && !pathInProject) {
			// Every protected target lives under the profile's parent (`~/.lunr`) or the project's `.lunr`,
			// which the hidden-name rule already covers, so the costly check runs only when they overlap.
			const profile = dirname(resolve(agentDir));
			project = { cwd: root, checkProtected: isWithin(profile, root) || isWithin(root, profile) };
		}
		this.projects.set(key, project);
		return project;
	}

	/** What `command` does, or undefined when any part of it is outside the rules and needs review. */
	plan(command: string, project: Project): Plan | undefined {
		if (command.length > MAX_COMMAND_LENGTH) return undefined;
		const parts = splitParts(lex(command));
		if (!parts) return undefined;
		const plan: Plan = { overlay: new Map(), needProof: [], record: [], forget: [], changesExisting: false };
		let paths = 0;
		for (const part of parts) {
			paths += part.args.length + part.redirects.length;
			if (paths > MAX_PATHS || !this.applyPart(part, project, plan)) return undefined;
		}
		return plan;
	}

	/** Checks one part against the rules and adds its effects to `plan`. */
	private applyPart(part: Part, project: Project, plan: Plan): boolean {
		const spec = OPTIONS[part.name];
		const operands = part.name === "sed" ? sedOperands(part.args) : spec ? options(part.args, spec) : undefined;
		if (!operands) return false;
		const at = (word: string) => resolvePath(word, project, plan.overlay);

		// Redirects are opened before the command runs, so they come first, as in bash.
		let stdin = part.heredoc;
		for (const { op, target } of part.redirects) {
			if (op === "2>&1" || op === ">&2") continue;
			if (target === undefined) return false;
			if (target === "/dev/null" && op !== "<") continue;
			if (op === "2>" || op === "2>>") return false;
			if (op === "<") {
				if (stdin || part.name !== "cat") return false;
				const input = at(target);
				if (!input || !readable(input)) return false;
				stdin = true;
				continue;
			}
			// Only commands that print their arguments or project files may fill a project file.
			const output = at(target);
			if (!OUTPUT_COMMANDS.has(part.name) || !output || !this.writes(output, plan)) return false;
		}

		switch (part.name) {
			case "echo":
				return true;
			case "printf":
				// `printf -v name` sets a variable, so no operand may look like an option.
				return operands.length > 0 && !operands.some((word) => word.startsWith("-"));
			case "cat":
				if (operands.length === 0) return stdin;
				return (
					!stdin &&
					operands.every((word) => {
						const input = at(word);
						return input !== undefined && readable(input);
					})
				);
			case "mkdir":
				return operands.length > 0 && this.makesDirectories(part, operands, project, plan);
			case "touch":
				// An existing file only gets a new time, so it needs no proof, but it must be a single regular file.
				return (
					operands.length > 0 &&
					operands.every((word) => {
						const target = at(word);
						if (!target) return false;
						if (target.state === "missing") return this.creates(target.path, plan);
						if (target.state === "dir" || !target.stat) return true;
						if (!target.stat.isFile() || target.stat.nlink > 1) return false;
						if (this.madeHere(target.path, target.stat)) plan.record.push(target.path);
						return true;
					})
				);
			case "rm":
				return (
					operands.length > 0 &&
					operands.every((word) => {
						const target = at(word);
						if (!target || target.state === "dir") return false;
						if (target.state === "file" && !this.changes(target, plan)) return false;
						plan.overlay.set(target.path, "gone");
						plan.forget.push(target.path);
						return true;
					})
				);
			case "cp":
			case "mv":
				return this.copiesOrMoves(part.name, operands, project, plan);
			case "sed":
				// Only `sed -i`: plain sed is a reader, and only echo, printf and cat may fill a file.
				return (
					part.args.includes("-i") &&
					operands.length > 0 &&
					operands.every((word) => {
						const target = at(word);
						return target?.state === "file" && this.changes(target, plan);
					})
				);
			default:
				return false;
		}
	}

	private makesDirectories(part: Part, operands: string[], project: Project, plan: Plan): boolean {
		const parents = part.args.some((arg) => arg === "--parents" || /^-[pv]*p[pv]*$/.test(arg));
		for (const word of operands) {
			const target = resolvePath(word, project, plan.overlay);
			if (!target || target.state === "file") return false;
			if (target.state === "dir") continue;
			plan.overlay.set(target.path, "dir");
			if (!parents) continue;
			for (let dir = dirname(target.path); dir !== project.cwd; dir = dirname(dir)) {
				if (!plan.overlay.has(dir) && !lstatSync(dir, { throwIfNoEntry: false })) plan.overlay.set(dir, "dir");
			}
		}
		return true;
	}

	private copiesOrMoves(name: "cp" | "mv", operands: string[], project: Project, plan: Plan): boolean {
		if (operands.length < 2) return false;
		const destination = resolvePath(operands[operands.length - 1], project, plan.overlay);
		if (!destination || (operands.length > 2 && destination.state !== "dir")) return false;
		for (const word of operands.slice(0, -1)) {
			const source = resolvePath(word, project, plan.overlay);
			// Only regular files: a directory could carry a symlink a later part writes through.
			if (!source || source.state !== "file" || (source.stat && !source.stat.isFile())) return false;
			const into =
				destination.state === "dir"
					? resolvePath(join(destination.path, basename(source.path)), project, plan.overlay)
					: destination;
			if (!into || into.state === "dir") return false;
			if (name === "cp") {
				if (!this.writes(into, plan)) return false;
				continue;
			}
			// The source loses its name, so mv changes it as rm would.
			const mine = source.stat ? this.madeHere(source.path, source.stat) : plan.overlay.get(source.path) === "mine";
			if (!this.changes(source, plan)) return false;
			if (into.state === "file" && !this.changes(into, plan)) return false;
			plan.overlay.set(source.path, "gone");
			plan.overlay.set(into.path, "mine");
			plan.forget.push(source.path);
			if (mine) plan.record.push(into.path);
		}
		return true;
	}

	/** A write that creates or replaces `target`; replacing needs `changes`. */
	private writes(target: Resolved, plan: Plan): boolean {
		if (target.state === "dir") return false;
		if (target.state === "missing") return this.creates(target.path, plan);
		return this.changes(target, plan);
	}

	private creates(path: string, plan: Plan): boolean {
		plan.overlay.set(path, "mine");
		plan.record.push(path);
		return true;
	}

	/**
	 * True when the line may change or remove the existing file `target`: a single regular file that
	 * this session made and nobody changed since, or one git must prove unchanged (`needProof`).
	 */
	private changes(target: Resolved, plan: Plan): boolean {
		if (!target.stat) return plan.overlay.get(target.path) === "mine";
		if (!target.stat.isFile() || target.stat.nlink > 1) return false;
		plan.changesExisting = true;
		if (this.madeHere(target.path, target.stat)) plan.record.push(target.path);
		else plan.needProof.push(target.path);
		plan.overlay.set(target.path, "mine");
		return true;
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

	private expect(toolCallId: string, { record, forget }: Pick<Plan, "record" | "forget">): void {
		if (record.length === 0 && forget.length === 0) return;
		// A call a later gate blocked never finishes; drop the oldest so the map stays small.
		if (this.pending.size >= 64) this.pending.delete(this.pending.keys().next().value ?? "");
		this.pending.set(toolCallId, { record, forget });
	}
}

/** A regular file `cat` may print. A FIFO would block the call. */
function readable(target: Resolved): boolean {
	return target.state === "file" && (target.stat === undefined || target.stat.isFile());
}

/** The tokens of `command`, or undefined for anything outside the grammar in the module comment. */
function lex(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let marker: string | undefined;
	let i = 0;
	while (i < command.length) {
		const ch = command[i];
		if (ch === " " || ch === "\t") {
			i++;
		} else if (ch === "\n") {
			tokens.push({ kind: "op", text: ";" });
			if (marker !== undefined) {
				// The body is literal text that ends at the first line that is exactly the marker.
				const end = command.indexOf(`\n${marker}\n`, i);
				const at = end >= 0 ? end : command.endsWith(`\n${marker}`) ? command.length - marker.length - 1 : -1;
				if (at < i) return undefined;
				i = at + 1 + marker.length;
				marker = undefined;
			} else i++;
		} else if (command.startsWith("&&", i)) {
			tokens.push({ kind: "op", text: "&&" });
			i += 2;
		} else if (ch === ";") {
			tokens.push({ kind: "op", text: ";" });
			i++;
		} else if (command.startsWith("<<", i)) {
			// Only `<<'MARKER'`: a quoted marker keeps the body literal.
			const match = /^<< ?'([^']*)'(?=[ \t\n;&>]|$)/.exec(command.slice(i, i + 80));
			if (!match || !HEREDOC_MARKER.test(match[1]) || marker !== undefined) return undefined;
			marker = match[1];
			tokens.push({ kind: "heredoc" });
			i += match[0].length;
		} else if (ch === ">" || ch === "<" || (ch === "2" && command[i + 1] === ">")) {
			const op = /^(?:2>&1|>&2|2>>|2>|>>|>|<)/.exec(command.slice(i, i + 4))?.[0] as RedirectOp | undefined;
			// `>|`, `>&-`, `<>`, `&>` and other descriptors stay outside the grammar.
			if (!op || /[|&<>(]/.test(command[i + op.length] ?? "")) return undefined;
			tokens.push({ kind: "redirect", text: op });
			i += op.length;
		} else {
			const start = i;
			let word = "";
			while (i < command.length && !/[ \t\n;&<>]/.test(command[i])) {
				const c = command[i];
				if (c === "'" || c === '"') {
					const close = command.indexOf(c, i + 1);
					if (close < 0) return undefined;
					const text = command.slice(i + 1, close);
					if (c === '"' && /[$`\\!]/.test(text)) return undefined;
					word += text;
					i = close + 1;
				} else if (UNQUOTED.test(c)) {
					word += c;
					i++;
				} else return undefined;
			}
			// A lone `&` (a background job) or `|` ends here with nothing read.
			if (i === start) return undefined;
			// `1>f` or `3<f`: bash reads the digits as a file descriptor, not a word.
			if (/^\d+$/.test(word) && (command[i] === ">" || command[i] === "<")) return undefined;
			tokens.push({ kind: "word", text: word });
		}
	}
	return marker === undefined ? tokens : undefined;
}

/** The parts of a line, or undefined for an empty part, a dangling redirect or two here-documents. */
function splitParts(tokens: Token[] | undefined): Part[] | undefined {
	if (!tokens) return undefined;
	const parts: Part[] = [];
	let current: Part | undefined;
	let lastOp: string | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === "op") {
			// `;` and newlines may repeat or trail; `&&` must join two commands.
			if (token.text === "&&" && !current) return undefined;
			if (current) parts.push(current);
			current = undefined;
			lastOp = token.text;
		} else if (!current) {
			// An assignment, a path or a redirect in command position is another program or a variable.
			if (token.kind !== "word" || !/^[a-z]+$/.test(token.text)) return undefined;
			current = { name: token.text, args: [], redirects: [], heredoc: false };
		} else if (token.kind === "word") current.args.push(token.text);
		else if (token.kind === "heredoc") {
			if (current.heredoc) return undefined;
			current.heredoc = true;
		} else if (token.text === "2>&1" || token.text === ">&2") current.redirects.push({ op: token.text });
		else {
			const target = tokens[i + 1];
			if (target?.kind !== "word") return undefined;
			current.redirects.push({ op: token.text, target: target.text });
			i++;
		}
	}
	if (current) parts.push(current);
	else if (lastOp === "&&") return undefined;
	return parts.length > 0 ? parts : undefined;
}

/** The operands of `args` when every option is in `spec`, else undefined. `--` ends the options. */
function options(args: readonly string[], spec: { short: string; long: readonly string[] }): string[] | undefined {
	const operands: string[] = [];
	let ended = false;
	for (const arg of args) {
		if (ended || arg === "-" || !arg.startsWith("-")) operands.push(arg);
		else if (arg === "--") ended = true;
		else if (arg.startsWith("--")) {
			if (!spec.long.includes(arg)) return undefined;
		} else if (![...arg.slice(1)].every((letter) => spec.short.includes(letter))) return undefined;
	}
	return operands;
}

/**
 * The files of `sed [-i|-E|-r|-n] [-e script]... [script] file...` when every script passes
 * read-only mode's sed check and reads no file (`r`, `R`). Undefined otherwise.
 */
function sedOperands(args: readonly string[]): string[] | undefined {
	const scripts: string[] = [];
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-e") {
			if (i + 1 >= args.length) return undefined;
			scripts.push(args[++i]);
		} else if (arg.startsWith("-")) {
			if (!["-i", "-E", "-r", "-n"].includes(arg)) return undefined;
		} else operands.push(arg);
	}
	if (scripts.length === 0) {
		const script = operands.shift();
		if (script === undefined) return undefined;
		scripts.push(script);
	}
	for (const script of scripts) {
		if (sedScriptReads(script)?.length !== 0) return undefined;
		if (isMutatingBashCommand(`sed -n '${script.replaceAll("'", "'\\''")}'`)) return undefined;
	}
	return operands;
}

/**
 * Where `word` leads, when it is a project path this module trusts: relative (or under the project
 * by absolute name), with no empty, `.`, `..` or hidden component after an optional leading `./`,
 * and no existing component that is a symlink or, before the last, not a directory. Each existing
 * prefix is read with `lstat` from the project down, so the kernel can't resolve it anywhere else.
 * Earlier parts' results in `overlay` take the place of the disk. Undefined for anything else. An
 * `lstat` error other than "missing" throws, which `allows` turns into review.
 */
function resolvePath(word: string, project: Project, overlay: Plan["overlay"]): Resolved | undefined {
	let rel = word.startsWith(`${project.cwd}/`) ? word.slice(project.cwd.length + 1) : word;
	if (rel.startsWith("./")) rel = rel.slice(2);
	rel = rel.replace(/\/+$/, "");
	if (rel === "" || isAbsolute(rel) || rel.includes("\\")) return undefined;
	const names = rel.split("/");
	if (names.some((name) => name === "" || name.startsWith("."))) return undefined;
	let path = project.cwd;
	let onDisk = true;
	let stat: Stats | undefined;
	for (const [index, name] of names.entries()) {
		path = join(path, name);
		const last = index === names.length - 1;
		const earlier = overlay.get(path);
		if (earlier === "gone" || earlier === "mine") {
			if (!last) return undefined;
			return guarded({ path, state: earlier === "gone" ? "missing" : "file" }, project);
		}
		if (earlier === "dir") {
			onDisk = false;
			stat = undefined;
			continue;
		}
		if (!onDisk) continue;
		stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat) onDisk = false;
		else if (stat.isSymbolicLink() || (!last && !stat.isDirectory())) return undefined;
	}
	return guarded({ path, state: !stat ? "missing" : stat.isDirectory() ? "dir" : "file", stat }, project);
}

function guarded(target: Resolved, project: Project): Resolved | undefined {
	return project.checkProtected && protectedTargetWriteReason(target.path, project.cwd) ? undefined : target;
}

function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when git proves every path tracked and unchanged: `git ls-files -s -v` lists it as a plain
 * entry (`H`, mode 100644 or 100755, stage 0, so not skip-worktree, assume-unchanged, a submodule
 * or a nested repository), and `git hash-object --no-filters` of the file gives the same blob. No
 * index refresh, filter, hook or fsmonitor runs, and `GIT_*` variables are dropped so the check
 * reads the project's own repository.
 */
async function gitUnchanged(paths: readonly string[], cwd: string): Promise<boolean> {
	const names = paths.map((path) => relative(cwd, path).split(sep).join("/"));
	const [listed, hashes] = await Promise.all([
		git(cwd, ["--literal-pathspecs", "ls-files", "-s", "-v", "-z", "--", ...names]),
		git(cwd, ["hash-object", "--no-filters", "--", ...names]),
	]);
	if (listed === undefined || hashes === undefined) return false;
	const stored = new Map<string, string>();
	for (const record of listed.split("\0")) {
		if (!record) continue;
		const match = /^H (?:100644|100755) ([0-9a-f]+) 0\t(.*)$/s.exec(record);
		if (!match) return false;
		stored.set(match[2], match[1]);
	}
	const actual = hashes.trim().split("\n");
	return actual.length === names.length && names.every((name, index) => stored.get(name) === actual[index]);
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	return new Promise((done) => {
		execFile(
			"git",
			["-c", "core.fsmonitor=false", "--no-optional-locks", ...args],
			{ cwd, env, timeout: GIT_TIMEOUT_MS },
			(error, stdout) => done(error ? undefined : stdout),
		);
	});
}
