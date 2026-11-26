/**
 * lunR: the commands a bash command line can run, as deny rules see them (`deniedCommandLines`).
 *
 * `scan` reads a text once with a small state machine for quotes, comments, here-documents and a
 * stack of open `$(...)`, backtick and `<(...)` bodies, so nesting needs no recursion. Data is not a
 * command: single-quoted text, double-quoted text outside substitutions, comments, redirect targets
 * and here-document bodies. `segmentLines` walks each segment's words with an index and emits a line
 * at every command start: after assignments, `!`, `{`, `if`/`then`/`do` and `function name`, at
 * every wrapper stage (`sudo`, `env`, `timeout 5`, `xargs`, ...) and for each `find -exec`. Bodies of
 * `sh -c`, `eval`, `env -S` and a here-document fed to a shell are queued and scanned the same way.
 * Each word and each segment's here-documents are queued at most once, so the text queued at one
 * level adds up to at most the text above it, and all queued text to (MAX_DEPTH + 1) x the input.
 * Past `MAX_DEPTH` levels, `MAX_STAGES` lines in one segment or the work budget (`left`) the result
 * is `uncheckable`.
 *
 * It does not see commands built while the shell runs (`$T`, `$(echo touch)`), text piped or
 * redirected into a shell, interpreters (`python -c`), `ssh`, `docker`, `su -c` or sourced files. A
 * command word bash expands (`{touch,x}`, `$'touch'`) is a `wildcard`: every rule's command word matches.
 */

/** One command a deny rule checks: a view of a segment's words from `start` to `end`. */
export interface DeniedLine {
	/** The segment's words, shared by every line cut from it. Arguments are `start + 1` to `end - 1`. */
	words: readonly string[];
	start: number;
	end: number;
	/** The command word's base name: `/usr/bin/touch` is `touch`. */
	name: string;
	/** bash expands the command word before running it, so any command name could result. */
	wildcard: boolean;
}

export interface DeniedCommands {
	lines: DeniedLine[];
	/** Nested, wrapped or costly past the limits, so the text may run commands not in `lines`. */
	uncheckable: boolean;
	/** Some line's command word is a `wildcard`. */
	wildcard: boolean;
	/** Command names of `lines`, built by the matcher when there are many. */
	names?: Set<string>;
	/** Characters scanned: the input plus every queued body. */
	queued: number;
	/** Work units left: characters queued and words visited, here and by the matcher. Below 0 is `uncheckable`. */
	left: number;
}

interface Segment {
	words: string[];
	/** Per word: bash expands it (brace list or `$'...'`), so its text is not what runs. */
	expanded: boolean[];
	heredocBodies?: string[];
}

/** One open level of the scan: the top level, or a `$(...)`/backtick/`<(...)` body. */
interface Frame {
	closer?: ")" | "`";
	/** Plain `(` open inside this body, so `$( (a) )` closes at the right `)`. */
	parens: number;
	quote?: "'" | '"';
	/** Made when the first word or here-document lands in it, so an empty `$(` costs little. */
	segment?: Segment;
	word: string;
	inWord: boolean;
	expanded: boolean;
	/** -1 outside a `{`, 0 inside one, 1 after a `,` or `..` inside one. */
	brace: number;
	/** The next word is a redirect target. */
	skipWord: boolean;
}

const MAX_DEPTH = 4;
const MAX_STAGES = 16;
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
const C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
/** A shell option that takes the next word as its value: `-o pipefail`, `-euo pipefail`, `+O extglob`. */
const VALUED_SHELL_OPTION = /^[-+][A-Za-z]*[oO]$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * The end marker bash takes from the here-document word at `start`: the word after quote removal,
 * so `\EOF`, `E"O"F` and `'E'OF` all end at a line `EOF`. `delimiter` is undefined when bash could
 * read the word differently than this does (a `$` or backtick, a line continuation) or rejects it
 * (an unclosed quote, no word).
 */
function heredocDelimiter(text: string, start: number): { delimiter: string | undefined; end: number } {
	let delimiter = "";
	let quote: "'" | '"' | undefined;
	let i = start;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else delimiter += ch;
		} else if (ch === "\\") {
			const next = text[i + 1];
			if (next === undefined || next === "\n") return { delimiter: undefined, end: i };
			// Inside double quotes a backslash is kept unless it escapes $ ` " or \.
			if (quote === '"' && !'$`"\\'.includes(next)) delimiter += ch;
			delimiter += next;
			i++;
		} else if (ch === "$" || ch === "`") return { delimiter: undefined, end: i };
		else if (quote === '"') {
			if (ch === '"') quote = undefined;
			else delimiter += ch;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (" \t\n;&|<>()".includes(ch)) break;
		else delimiter += ch;
	}
	return { delimiter: quote || i === start ? undefined : delimiter, end: i };
}

/**
 * Adds the segments of `text` to `segments` in one pass (see the module comment). Returns true when
 * a here-document's end marker can't be resolved, so later lines may be body or commands.
 */
function scan(text: string, segments: Segment[]): boolean {
	const newFrame = (closer?: ")" | "`"): Frame => ({
		closer,
		parens: 0,
		word: "",
		inWord: false,
		expanded: false,
		brace: -1,
		skipWord: false,
	});
	const stack = [newFrame()];
	let f = stack[0];
	const heredocs: Array<{ delimiter: string; stripTabs: boolean; segment: Segment }> = [];
	let unresolved = false;

	const segment = () => {
		f.segment ??= { words: [], expanded: [] };
		return f.segment;
	};
	const endWord = () => {
		if (f.inWord && f.skipWord) f.skipWord = false;
		else if (f.inWord) {
			segment().words.push(f.word);
			segment().expanded.push(f.expanded);
		}
		f.word = "";
		f.inWord = false;
		f.expanded = false;
		f.brace = -1;
	};
	const endSegment = () => {
		endWord();
		f.skipWord = false;
		if (f.segment && f.segment.words.length > 0) segments.push(f.segment);
		f.segment = undefined;
	};
	/** Opens a substitution body; `$(...)` and backticks leave a placeholder in the current word. */
	const open = (closer: ")" | "`", inWord: boolean) => {
		if (inWord) {
			f.word += SUBSTITUTION;
			f.inWord = true;
		}
		f = newFrame(closer);
		stack.push(f);
	};
	const close = () => {
		endSegment();
		stack.pop();
		f = stack[stack.length - 1];
	};
	/** After a newline: reads the bodies of the here-documents opened before it. */
	const readHeredocs = (newline: number): number => {
		let i = newline;
		for (const heredoc of heredocs.splice(0)) {
			const body: string[] = [];
			while (i < text.length) {
				const end = text.indexOf("\n", i + 1);
				const line = text.slice(i + 1, end === -1 ? text.length : end);
				i = end === -1 ? text.length : end;
				if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
				body.push(line);
			}
			heredoc.segment.heredocBodies ??= [];
			heredoc.segment.heredocBodies.push(body.join("\n"));
		}
		return i;
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (ch === "`" && f.closer === "`") close();
		else if (f.quote === "'") {
			if (ch === "'") f.quote = undefined;
			else f.word += ch;
		} else if (ch === "\\" && (f.quote === undefined || (next !== undefined && '$`"\\\n'.includes(next)))) {
			if (next !== undefined && next !== "\n") {
				f.word += next;
				f.inWord = true;
			}
			i++;
		} else if (f.quote === '"') {
			if (ch === '"') f.quote = undefined;
			else if (ch === "$" && next === "(") {
				open(")", true);
				i++;
			} else if (ch === "`") open("`", true);
			else f.word += ch;
		} else if (ch === "'" || ch === '"') {
			f.quote = ch;
			f.inWord = true;
		} else if (ch === "$" && next === "'") {
			f.quote = "'";
			f.inWord = true;
			f.expanded = true;
			i++;
		} else if ((ch === "$" || ch === "<" || ch === ">") && next === "(") {
			open(")", ch === "$");
			i++;
		} else if (ch === "`") open("`", true);
		else if (ch === "#" && !f.inWord) {
			const end = text.indexOf("\n", i);
			i = (end === -1 ? text.length : end) - 1;
		} else if (ch === " " || ch === "\t" || ch === "\r") endWord();
		else if (ch === "\n") {
			// A pending here-document keeps the segment that opened it, so its body reaches that command.
			endSegment();
			if (heredocs.length > 0) i = readHeredocs(i);
		} else if (ch === "<" || ch === ">" || (ch === "&" && next === ">")) {
			// A digit word right before is the redirect's file descriptor, not an argument.
			if (f.inWord && /^\d+$/.test(f.word)) f.inWord = false;
			endWord();
			if (ch === "<" && next === "<" && text[i + 2] !== "<") {
				i += 2;
				const stripTabs = text[i] === "-";
				if (stripTabs) i++;
				while (text[i] === " " || text[i] === "\t") i++;
				const { delimiter, end } = heredocDelimiter(text, i);
				unresolved ||= delimiter === undefined;
				heredocs.push({ delimiter: delimiter ?? "", stripTabs, segment: segment() });
				i = end - 1;
				continue;
			}
			while (text[i + 1] === "<" || text[i + 1] === ">" || text[i + 1] === "&" || text[i + 1] === "|") i++;
			f.skipWord = true;
		} else if (ch === ")" && f.closer === ")" && f.parens === 0) close();
		else if (ch === "(" || ch === ")") {
			endSegment();
			f.parens = Math.max(f.parens + (ch === "(" ? 1 : -1), 0);
		} else if (ch === ";" || ch === "&" || ch === "|") endSegment();
		else {
			if (ch === "{") f.brace = 0;
			else if (f.brace >= 0 && (ch === "," || (ch === "." && next === "."))) f.brace = 1;
			else if (ch === "}") {
				f.expanded ||= f.brace === 1;
				f.brace = -1;
			}
			f.word += ch;
			f.inWord = true;
		}
	}
	while (stack.length > 1) close();
	endSegment();
	return unresolved;
}

function basenameOf(word: string): string {
	if (!word.includes("/") && !word.includes("\\")) return word;
	return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
}

/** `env -S 'cmd'` / `-Scmd` / `--split-string=cmd`: the command text env splits and runs. */
function envSplitString(option: string, value: string | undefined): string | undefined {
	if (option === "-S" || option === "--split-string") return value;
	if (option.startsWith("--split-string=")) return option.slice("--split-string=".length);
	return option.startsWith("-S") && option.length > 2 ? option.slice(2) : undefined;
}

/** Adds the commands one segment runs to `result`, queuing the bodies other shells run. */
function segmentLines(
	segment: Segment,
	depth: number,
	result: DeniedCommands,
	queue: Array<{ text: string; depth: number }>,
): void {
	const { words, expanded } = segment;
	// A word, and the segment's here-documents (key -1), are queued at most once.
	let queued: Set<number> | undefined;
	const nested = (key: number, text: string | undefined) => {
		if (text === undefined || queued?.has(key)) return;
		queued ??= new Set();
		queued.add(key);
		if (depth >= MAX_DEPTH) result.uncheckable = true;
		result.queued += text.length;
		result.left -= text.length;
		queue.push({ text, depth: depth + 1 });
	};
	// `find -exec` adds ranges while the loop runs.
	const ranges: Array<[start: number, end: number]> = [[0, words.length]];
	let stages = 0;
	for (const [start, end] of ranges) {
		result.left -= end - start;
		let i = start;
		let command: string | undefined;
		while (i < end) {
			const word = words[i];
			if (PREFIX_WORDS.has(word) || ASSIGNMENT.test(word)) {
				i++;
				continue;
			}
			if (word === "function") {
				i += 2;
				continue;
			}
			if (++stages > MAX_STAGES) {
				result.uncheckable = true;
				return;
			}
			const name = basenameOf(word);
			result.lines.push({ words, start: i, end, name, wildcard: expanded[i] === true });
			result.wildcard ||= expanded[i] === true;
			const wrapper = WRAPPERS.get(name);
			if (!wrapper) {
				command = name;
				break;
			}
			for (i++; i < end && (words[i].startsWith("-") || (name === "env" && ASSIGNMENT.test(words[i]))); ) {
				if (words[i] === "--") {
					i++;
					break;
				}
				if (name === "env") {
					const glued = envSplitString(words[i], undefined);
					if (glued !== undefined) nested(i, glued);
					else if (words[i] === "-S" || words[i] === "--split-string") nested(i + 1, words[i + 1]);
				}
				i += wrapper.valued.has(words[i]) ? 2 : 1;
			}
			i += wrapper.positionals;
		}
		if (command === undefined) continue;
		const arg = (k: number) => (k < end ? words[k] : undefined);
		if (C_FLAG_RUNNERS.has(command)) {
			// Only options before the first other word: `bash run.sh -c x` passes `-c` to run.sh.
			for (let k = i + 1; k < end && /^[-+]/.test(words[k]); k++) {
				if (C_FLAG.test(words[k])) {
					const body = arg(k + 1) === "--" ? k + 2 : k + 1;
					nested(body, arg(body));
					break;
				}
				if (VALUED_SHELL_OPTION.test(words[k])) k++;
			}
		}
		if (SHELLS.has(command) && segment.heredocBodies) nested(-1, segment.heredocBodies.join("\n"));
		if (command === "eval") nested(i, words.slice(i + 1, end).join(" "));
		if (command === "find") {
			let exec = -1;
			for (let k = i + 1; k < end; k++) {
				if (exec === -1 && FIND_EXEC.has(words[k])) exec = k;
				else if (exec !== -1 && (words[k] === ";" || words[k] === "+")) {
					ranges.push([exec + 1, k]);
					exec = -1;
				}
			}
			if (exec !== -1) ranges.push([exec + 1, end]);
		}
	}
}

/**
 * The commands `command` can run, normalized for deny rules (see the module comment). `budget` is
 * the work units the whole check may spend; the matcher spends from the same `left`.
 */
export function deniedCommandLines(command: string, budget = Number.POSITIVE_INFINITY): DeniedCommands {
	const result: DeniedCommands = {
		lines: [],
		uncheckable: false,
		wildcard: false,
		queued: command.length,
		left: budget - command.length,
	};
	const queue = [{ text: command, depth: 0 }];
	for (const { text, depth } of queue) {
		if (result.left < 0) result.uncheckable = true;
		if (result.uncheckable) break;
		const segments: Segment[] = [];
		if (scan(text, segments)) result.uncheckable = true;
		for (const segment of segments) segmentLines(segment, depth, result, queue);
	}
	if (result.left < 0) result.uncheckable = true;
	return result;
}
