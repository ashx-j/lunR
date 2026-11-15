/**
 * lunR: the commands a bash command line can run, as deny rules see them (`deniedCommandLines`).
 *
 * One left-to-right pass over the text, in this order of priorities:
 * 1. Bounded cost: one pass per text, nesting at most `MAX_NESTING` deep, at most `MAX_LINES` lines.
 * 2. Data is not a command: single-quoted text, double-quoted text outside `$(...)` and backticks,
 *    comments, redirect targets and here-document bodies (unless the here-document feeds a shell).
 * 3. The plain and the common wrapped forms are commands: every `;`/`&&`/`|`/newline/`(`/`)`
 *    segment, `$(...)`/backtick/`<(...)` bodies, after assignments, `!`, `{`, `if`/`then`/`do`, a
 *    leading redirect and `function name`, at every stage of a wrapper (`sudo`, `env`, `timeout 5`,
 *    `xargs`, ...), and the bodies of `sh -c`, `eval`, `env -S` and `find -exec`.
 *
 * It does not see commands built while the shell runs (`$T`, `$(echo touch)`), text piped or
 * redirected into a shell, interpreters (`python -c`), `ssh`, `docker`, `su -c` or sourced files. A
 * command word bash expands before running (`{touch,x}`, `$'touch'`) is reported as `wildcard`, so
 * every deny rule's command word matches it.
 */

/** One command a deny rule checks: its words, the first reduced to its base name. */
export interface DeniedLine {
	words: string[];
	/** The command word is expanded by bash before running, so any command name could result. */
	wildcard: boolean;
}

interface Segment {
	words: string[];
	/** Per word: bash expands it (brace list or `$'...'`), so its text is not what runs. */
	expanded: boolean[];
	heredocBodies: string[];
}

const MAX_NESTING = 4;
const MAX_LINES = 256;
/** Stands in for a `$(...)` or backtick inside a word; its body is checked on its own. */
const SUBSTITUTION = "\u0001";

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that start a command without being it. */
const PREFIX_WORDS = new Set(["!", "{", "}", "if", "then", "do", "else", "elif", "while", "until", "time"]);
/** Commands that run the command after them: options that take a value, and positionals before it. */
const WRAPPERS = new Map<string, { valued: ReadonlySet<string>; positionals: number }>([
	["command", { valued: new Set(), positionals: 0 }],
	["builtin", { valued: new Set(), positionals: 0 }],
	["exec", { valued: new Set(["-a"]), positionals: 0 }],
	["env", { valued: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]), positionals: 0 }],
	["nohup", { valued: new Set(), positionals: 0 }],
	["time", { valued: new Set(["-f", "-o"]), positionals: 0 }],
	["timeout", { valued: new Set(["-s", "-k", "--signal", "--kill-after"]), positionals: 1 }],
	["nice", { valued: new Set(["-n", "--adjustment"]), positionals: 0 }],
	["ionice", { valued: new Set(["-c", "-n", "-p", "-P", "-u"]), positionals: 0 }],
	["stdbuf", { valued: new Set(["-i", "-o", "-e"]), positionals: 0 }],
	["setsid", { valued: new Set(), positionals: 0 }],
	["flock", { valued: new Set(["-w", "-E", "--timeout", "--conflict-exit-code"]), positionals: 1 }],
	["taskset", { valued: new Set(), positionals: 1 }],
	["strace", { valued: new Set(["-o", "-e", "-p", "-s", "-a", "-P", "-u", "-E"]), positionals: 0 }],
	["busybox", { valued: new Set(), positionals: 0 }],
	["xargs", { valued: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"]), positionals: 0 }],
	["sudo", { valued: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U"]), positionals: 0 }],
	["doas", { valued: new Set(["-u", "-C"]), positionals: 0 }],
]);
/** Commands whose `-c` (alone or in a flag cluster) takes a command to run. */
const C_FLAG_RUNNERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "script"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function basenameOf(word: string): string {
	return word.split(/[\\/]/).pop() ?? word;
}

/** The body of `$(` / `<(` / `>(` starting at `start` (just after the `(`), by counting parentheses. */
function readParenBody(text: string, start: number): [body: string, end: number] {
	let depth = 1;
	for (let i = start; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return [text.slice(start, i), i];
	}
	return [text.slice(start), text.length - 1];
}

function readBacktickBody(text: string, start: number): [body: string, end: number] {
	for (let i = start; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === "`") return [text.slice(start, i), i];
	}
	return [text.slice(start), text.length - 1];
}

/** Splits `command` into segments of unquoted words, collecting substitution bodies in `nested`. */
function scan(command: string, nested: string[]): Segment[] {
	const segments: Segment[] = [];
	const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; segment: Segment }> = [];
	let segment: Segment = { words: [], expanded: [], heredocBodies: [] };
	let word = "";
	let unquoted = "";
	let inWord = false;
	let expanded = false;
	let quote: "'" | '"' | undefined;
	let skipNextWord = false;

	const endWord = () => {
		if (inWord) {
			if (skipNextWord) skipNextWord = false;
			else {
				segment.words.push(word);
				segment.expanded.push(expanded || /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/.test(unquoted));
			}
		}
		word = "";
		unquoted = "";
		inWord = false;
		expanded = false;
	};
	const endSegment = () => {
		endWord();
		skipNextWord = false;
		if (segment.words.length > 0) segments.push(segment);
		segment = { words: [], expanded: [], heredocBodies: [] };
	};
	/** After a newline: consumes the bodies of here-documents opened on the line before. */
	const readHeredocs = (newline: number): number => {
		let i = newline;
		for (const heredoc of pendingHeredocs.splice(0)) {
			const body: string[] = [];
			for (;;) {
				const end = command.indexOf("\n", i + 1);
				const line = command.slice(i + 1, end === -1 ? undefined : end);
				i = end === -1 ? command.length : end;
				const isDelimiter = (heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter;
				if (!isDelimiter) body.push(line);
				if (isDelimiter || end === -1) break;
			}
			heredoc.segment.heredocBodies.push(body.join("\n"));
		}
		return i;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
				if (next !== "\n") word += next;
				i++;
			} else if (ch === '"') quote = undefined;
			else if (ch === "$" && next === "(") {
				const [body, end] = readParenBody(command, i + 2);
				nested.push(body);
				word += SUBSTITUTION;
				i = end;
			} else if (ch === "`") {
				const [body, end] = readBacktickBody(command, i + 1);
				nested.push(body);
				word += SUBSTITUTION;
				i = end;
			} else word += ch;
			continue;
		}
		if (ch === "\\") {
			if (next !== undefined && next !== "\n") {
				word += next;
				inWord = true;
			}
			i++;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "$" && next === "'") {
			quote = "'";
			inWord = true;
			expanded = true;
			i++;
		} else if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
			const [body, end] = readParenBody(command, i + 2);
			nested.push(body);
			if (ch === "$") {
				word += SUBSTITUTION;
				inWord = true;
			}
			i = end;
		} else if (ch === "`") {
			const [body, end] = readBacktickBody(command, i + 1);
			nested.push(body);
			word += SUBSTITUTION;
			inWord = true;
			i = end;
		} else if (ch === "#" && !inWord) {
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
		} else if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
		} else if (ch === "\n") {
			// A pending here-document keeps the segment that opened it, so its body reaches that command.
			endSegment();
			if (pendingHeredocs.length > 0) i = readHeredocs(i);
		} else if (ch === "<" || ch === ">" || (ch === "&" && next === ">")) {
			// A digit word right before is the redirect's file descriptor, not an argument.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				unquoted = "";
				inWord = false;
			} else endWord();
			if (ch === "<" && next === "<" && command[i + 2] !== "<") {
				i += 2;
				const stripTabs = command[i] === "-";
				if (stripTabs) i++;
				while (command[i] === " " || command[i] === "\t") i++;
				const match = /^(['"]?)([^\s;&|<>'"]*)\1/.exec(command.slice(i));
				const delimiter = match?.[2] ?? "";
				pendingHeredocs.push({ delimiter, stripTabs, segment });
				i += Math.max((match?.[0].length ?? 0) - 1, 0);
				continue;
			}
			while (command[i + 1] === "<" || command[i + 1] === ">" || command[i + 1] === "&" || command[i + 1] === "|") {
				i++;
			}
			skipNextWord = true;
		} else if (ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			endSegment();
		} else {
			word += ch;
			unquoted += ch;
			inWord = true;
		}
	}
	endSegment();
	return segments;
}

/** Index of the first word after a wrapper's options and positionals. */
function skipWrapper(name: string, words: string[], start: number): number {
	const wrapper = WRAPPERS.get(name);
	let i = start;
	while (i < words.length && (words[i].startsWith("-") || (name === "env" && ASSIGNMENT.test(words[i])))) {
		if (words[i] === "--") return i + 1 + (wrapper?.positionals ?? 0);
		i += wrapper?.valued.has(words[i]) ? 2 : 1;
	}
	return i + (wrapper?.positionals ?? 0);
}

/** `env -S 'cmd'` / `env --split-string=cmd`: the command text env splits and runs. */
function envSplitString(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-S" || args[i] === "--split-string") return args[i + 1];
		if (args[i].startsWith("--split-string=")) return args[i].slice("--split-string=".length);
		if (args[i].startsWith("-S") && args[i].length > 2) return args[i].slice(2);
	}
	return undefined;
}

function linesFromSegment(segment: Segment, depth: number, out: DeniedLine[]): void {
	const { words, expanded } = segment;
	let i = 0;
	let viaXargs = false;
	let commandName: string | undefined;
	while (i < words.length && out.length < MAX_LINES) {
		const word = words[i];
		if (PREFIX_WORDS.has(word) || ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (word === "function") {
			i += 2;
			continue;
		}
		const name = basenameOf(word);
		const args = words.slice(i + 1);
		const wildcard = expanded[i] === true;
		out.push({ words: [name, ...args], wildcard });
		// xargs adds arguments from its input, so the command may get more than the text shows.
		if (viaXargs) out.push({ words: [name, ...args, "_"], wildcard });
		if (name === "env") {
			const split = envSplitString(args);
			if (split !== undefined) nestedLines(split, depth + 1, out);
		}
		if (!WRAPPERS.has(name)) {
			commandName = name;
			break;
		}
		viaXargs ||= name === "xargs";
		i = skipWrapper(name, words, i + 1);
	}
	if (commandName === undefined || depth >= MAX_NESTING) return;
	const args = words.slice(i + 1);
	if (C_FLAG_RUNNERS.has(commandName)) {
		const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
		const body = args[flag + 1] === "--" ? args[flag + 2] : args[flag + 1];
		if (flag !== -1 && body !== undefined) nestedLines(body, depth + 1, out);
	}
	if (SHELLS.has(commandName)) {
		for (const body of segment.heredocBodies) nestedLines(body, depth + 1, out);
	}
	if (commandName === "eval") nestedLines(args.join(" "), depth + 1, out);
	if (commandName === "find") {
		args.forEach((arg, index) => {
			if (!FIND_EXEC.has(arg)) return;
			const end = args.findIndex((word, after) => after > index && (word === ";" || word === "+"));
			const execWords = args.slice(index + 1, end === -1 ? undefined : end);
			linesFromSegment(
				{ words: execWords, expanded: execWords.map(() => false), heredocBodies: [] },
				depth + 1,
				out,
			);
		});
	}
}

function nestedLines(command: string, depth: number, out: DeniedLine[]): void {
	if (depth > MAX_NESTING || out.length >= MAX_LINES) return;
	const nested: string[] = [];
	for (const segment of scan(command, nested)) linesFromSegment(segment, depth, out);
	for (const body of nested) nestedLines(body, depth + 1, out);
}

/** The commands `command` can run, normalized for deny rules (see the module comment). */
export function deniedCommandLines(command: string): DeniedLine[] {
	const out: DeniedLine[] = [];
	nestedLines(command, 0, out);
	return out.slice(0, MAX_LINES);
}
