import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { isInteractiveHost } from "../session-resources.ts";
import type { ClaudeCodeToolResult } from "./claude-code-loopback.ts";
import { type ClaudeCodeEvent, claudeCodeEvents, stopProcessTree } from "./claude-code-process.ts";

type Block = Record<string, unknown>;

/** One stream-json input line, as the bridge builds it from lunR's history. */
export interface SessionFrame {
	type: "user" | "assistant";
	message: { role: "user" | "assistant"; model?: string; content: Block[] };
}

/**
 * What a live process must do to answer lunR's next request. `replay` fills a fresh process with the whole
 * history; `query` adds one user turn after a finished answer; `tools` hands back the results of the tool
 * calls Claude Code is waiting on.
 */
export type SessionStep =
	| { kind: "replay"; frames: SessionFrame[] }
	| { kind: "query"; frame: SessionFrame }
	| { kind: "tools"; results: Map<string, ClaudeCodeToolResult> };

/**
 * Stops a process that sat unused this long. In the TUI it matches the 1h prompt cache TTL Claude Code
 * writes: while the cache lives, the kept process saves a restart and the history rewrite a restart costs.
 * Headless hosts (print, RPC, ACP, the gateway) may hold one process per chat at about 210 MB each, so
 * they keep an idle one for 10 minutes, long enough for a chat's next message. Never raise either above
 * 65 minutes: after that much idle time Claude Code's microcompact clears old tool results in its copy,
 * and no switch turns that off.
 */
export function claudeCodeSessionIdleMs(): number {
	return isInteractiveHost() ? 60 * 60 * 1000 : 10 * 60 * 1000;
}
/** Measured unchanged up to 500,000 characters (3 MB became a file preview); larger ok results go one-shot. */
const MAX_OK_RESULT_CHARS = 400_000;
/** Claude Code cuts an error result above 11,024 characters to its first and last 5,000. */
const MAX_ERROR_RESULT_CHARS = 10_000;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

const ASSISTANT_TYPES: ReadonlySet<unknown> = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);
/**
 * Line types that never mean Claude Code's copy changed: `stream_event` is the raw answer lunR relays,
 * `assistant` is Claude Code's record of that same answer, `result` ends a turn, and `rate_limit_event`
 * reports quota. `system` and `user` lines are checked one by one in `verify`; any other type is not.
 */
const HARMLESS_TYPES: ReadonlySet<unknown> = new Set(["stream_event", "assistant", "result", "rate_limit_event"]);

/**
 * Whether Claude Code keeps an assistant turn in the order lunR has it. 2.1.310 moves every text block
 * that follows a tool_use ahead of the tool calls, in its live copy and in a replay alike. Measured
 * unchanged against a recording upstream, live and replayed: one text; thinking then text; two thinking
 * blocks; two texts in a row; text, thinking, text; one tool call; thinking, text or both before tool calls;
 * parallel calls with text before them; thinking or redacted thinking between tool calls; a call with empty
 * input; redacted thinking before a call. So the rule is: only those four block types, and no text after
 * the first tool_use.
 */
export function keepsOrder(blocks: readonly Block[]): boolean {
	let afterTool = false;
	for (const block of blocks) {
		if (!ASSISTANT_TYPES.has(block.type)) return false;
		if (block.type === "tool_use") afterTool = true;
		else if (block.type === "text" && afterTool) return false;
	}
	return true;
}

/**
 * Whether Claude Code records lunR's tool_result block unchanged when lunR hands it over as an MCP result.
 * Measured on 2.1.310 against a recording upstream, for ok and error results from 1 to 200,000 characters,
 * blank and edge whitespace, CR, CRLF, ANSI codes, NUL and other control characters, a BOM, emoji, its own
 * tags and markers, and long single lines:
 * - an ok result whose text is blank after `trim()` becomes "(<tool> completed with no output)";
 * - an error result is trimmed (`trim()`, so a BOM goes too), becomes "Command failed with no output"
 *   when blank, and is cut above 11,024 characters;
 * - a lone surrogate becomes U+FFFD in both;
 * - everything else, including ok results of any measured length, comes back as sent.
 * lunR sends text-only results as one string; images and other blocks are left out.
 */
export function keepsToolResult(block: Block): boolean {
	const keys = Object.keys(block).filter((key) => key !== "is_error");
	if (keys.length !== 3 || !keys.includes("tool_use_id") || !keys.includes("content")) return false;
	const text = block.content;
	if (typeof text !== "string" || LONE_SURROGATE.test(text)) return false;
	if (block.is_error === true) return text.length > 0 && text.length <= MAX_ERROR_RESULT_CHARS && text === text.trim();
	return block.is_error === undefined || block.is_error === false
		? text.trim() !== "" && text.length <= MAX_OK_RESULT_CHARS
		: false;
}

/** The MCP answer for a tool_result `keepsToolResult` accepts; Claude Code records it as `block`. */
function toolResult(block: Block): ClaudeCodeToolResult | undefined {
	if (!keepsToolResult(block) || typeof block.content !== "string") return undefined;
	const content = [{ type: "text" as const, text: block.content }];
	return block.is_error === true ? { content, isError: true } : { content };
}

/** Whether Claude Code's tool result line holds what lunR sent: a string equals its one text block. */
function sameToolResult(recorded: unknown, expected: ClaudeCodeToolResult): boolean {
	if (!isRecord(recorded)) return false;
	const text = expected.content[0]?.text;
	const content = recorded.content;
	const sameContent =
		content === text ||
		(Array.isArray(content) && content.length === 1 && isDeepStrictEqual(content[0], { type: "text", text }));
	return sameContent && (recorded.is_error === true) === (expected.isError === true);
}

/**
 * Rebuilds the assistant content Claude Code keeps from the raw Messages stream events it emitted, in the
 * shape lunR's next request carries it.
 */
export class StreamedAnswer {
	readonly blocks: Block[] = [];
	stopReason: unknown;
	private readonly json = new Map<number, string>();

	add(event: Record<string, unknown>): void {
		const index = typeof event.index === "number" ? event.index : -1;
		if (event.type === "content_block_start" && isRecord(event.content_block)) {
			const { caller, ...block } = event.content_block;
			// Anthropic marks a model's own tool calls `caller: direct`; lunR's history leaves the default out.
			if (caller !== undefined && !isDeepStrictEqual(caller, { type: "direct" })) block.caller = caller;
			if (block.type === "tool_use") this.json.set(index, "");
			this.blocks[index] = block;
		} else if (event.type === "content_block_delta" && isRecord(event.delta)) {
			const block = this.blocks[index];
			const delta = event.delta;
			if (!block) return;
			if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
			else if (delta.type === "thinking_delta") block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
			else if (delta.type === "signature_delta") block.signature = `${block.signature ?? ""}${delta.signature}`;
			else if (delta.type === "input_json_delta")
				this.json.set(index, `${this.json.get(index)}${delta.partial_json}`);
		} else if (event.type === "content_block_stop") {
			const json = this.json.get(index);
			const block = this.blocks[index];
			if (json !== undefined && block) block.input = json ? JSON.parse(json) : {};
		} else if (event.type === "message_delta" && isRecord(event.delta)) {
			this.stopReason = event.delta.stop_reason;
		}
	}
}

/**
 * One Claude Code process kept alive for one lunR session. Claude Code holds its own copy of the
 * conversation, so a request may reuse the process only when it continues exactly that copy: same
 * process key (model route, system prompt, tools, thinking, effort, output limit) and a history equal to
 * the held one plus the streamed answer plus one new user turn. Anything else stops the process.
 */
export class ClaudeCodeSession {
	readonly key: string;
	readonly events: AsyncGenerator<ClaudeCodeEvent>;
	/** Set while a request runs on this process. */
	busy = false;
	/** When a request last ran here, for evicting the least recently used process. */
	lastUsed = Date.now();
	/** Set when Claude Code printed a line `verify` refused; the process stops after the current answer. */
	drifted = false;
	closed = false;

	private readonly child: ChildProcessWithoutNullStreams;
	private readonly cleanup: () => Promise<void>;
	/** The frames Claude Code holds, in the bridge's shape. Empty until the first step. */
	private held: SessionFrame[] = [];
	private started = false;
	/** The answer streamed for the last request; lunR's next request must carry it unchanged. */
	private answer: StreamedAnswer | undefined;
	/** Tool calls the answer asked for that Claude Code has not made yet. */
	private readonly expected = new Set<unknown>();
	/** Tool calls Claude Code made before lunR read the answer's block for them. */
	private readonly early = new Set<string>();
	/** Tool results lunR supplied for calls Claude Code has not made yet, and calls waiting for results. */
	private readonly results = new Map<string, ClaudeCodeToolResult>();
	private readonly waiting = new Map<string, (result: ClaudeCodeToolResult | undefined) => void>();
	private idle: NodeJS.Timeout | undefined;
	private closing: Promise<void> | undefined;

	constructor(key: string, child: ChildProcessWithoutNullStreams, cleanup: () => Promise<void>) {
		this.key = key;
		this.child = child;
		this.cleanup = cleanup;
		this.events = claudeCodeEvents(child.stdout);
		child.once("close", () => void this.close());
		this.armIdleTimer();
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** Writes one stream-json input line. */
	write(frame: object): void {
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	/**
	 * The step that continues the held conversation into `history`, or undefined when `history` is anything
	 * else. Compares content, never counts.
	 */
	plan(key: string, history: readonly SessionFrame[]): SessionStep | undefined {
		if (this.closed || this.busy || key !== this.key) return undefined;
		if (!this.started) return { kind: "replay", frames: [...history] };
		const answer = this.answer;
		const held = this.held.length;
		if (!answer || !keepsOrder(answer.blocks) || history.length !== held + 2) return undefined;
		if (!isDeepStrictEqual(history.slice(0, held), this.held)) return undefined;
		if (!isDeepStrictEqual(history[held]?.message.content, answer.blocks)) return undefined;
		const next = history[held + 1];
		if (next?.type !== "user") return undefined;
		const content = next.message.content;
		if (answer.stopReason === "end_turn") {
			if (content.some((block) => block.type === "tool_result")) return undefined;
			return { kind: "query", frame: next };
		}
		if (answer.stopReason !== "tool_use") return undefined;
		const calls = answer.blocks.filter((block) => block.type === "tool_use").map((block) => block.id);
		if (content.length !== calls.length) return undefined;
		const results = new Map<string, ClaudeCodeToolResult>();
		for (const [index, block] of content.entries()) {
			const result = block.type === "tool_result" && block.tool_use_id === calls[index] && toolResult(block);
			if (!result || typeof block.tool_use_id !== "string") return undefined;
			results.set(block.tool_use_id, result);
		}
		return { kind: "tools", results };
	}

	/**
	 * Marks the process busy with `step` for `history` and hands over tool results. The caller writes any
	 * frames itself and then reads `events`.
	 */
	begin(step: SessionStep, history: readonly SessionFrame[]): void {
		clearTimeout(this.idle);
		this.busy = true;
		this.lastUsed = Date.now();
		this.started = true;
		this.held = [...history];
		this.answer = new StreamedAnswer();
		if (step.kind !== "tools") return;
		for (const [id, result] of step.results) {
			const resolve = this.waiting.get(id);
			this.waiting.delete(id);
			if (resolve) resolve(result);
			else this.results.set(id, result);
		}
	}

	/**
	 * Records one raw stream event of the current answer. A tool call is expected from its block start on:
	 * Claude Code may call the tool as soon as the block ends, before the answer's `message_stop`.
	 */
	observe(event: Record<string, unknown>): void {
		this.answer?.add(event);
		const block = event.content_block;
		if (event.type !== "content_block_start" || !isRecord(block) || block.type !== "tool_use") return;
		if (typeof block.id === "string" && this.early.delete(block.id)) return;
		this.expected.add(block.id);
	}

	/**
	 * Checks a line Claude Code printed since the last answer. Allowed: the types in `HARMLESS_TYPES`;
	 * `system/init` (a query starts); `system/status` with status "requesting" or null and no `compact_*`
	 * field (progress; compaction reports through status too); `system/thinking_tokens` (thinking
	 * progress); and in a tools step the `user` echo of exactly the tool results lunR sent. Everything else,
	 * the failure hook's lines included (they follow a failed call Claude Code recorded), means the held
	 * copy may differ from lunR's history. The echo comes after Claude Code has sent its request, so every
	 * change Claude Code makes to a tool result must already be ruled out by `keepsToolResult` in `plan`.
	 */
	verify(event: ClaudeCodeEvent, step: SessionStep | undefined): boolean {
		if (HARMLESS_TYPES.has(event.type)) return true;
		if (event.type === "system") {
			if (event.subtype === "init" || event.subtype === "thinking_tokens") return true;
			return (
				event.subtype === "status" &&
				(event.status === "requesting" || event.status === null || event.status === undefined) &&
				!Object.keys(event).some((key) => key.startsWith("compact"))
			);
		}
		if (event.type !== "user" || step?.kind !== "tools") return false;
		if (!isRecord(event.message) || !Array.isArray(event.message.content)) return false;
		return event.message.content.every((block) => {
			if (!isRecord(block) || block.type !== "tool_result") return false;
			const expected = typeof block.tool_use_id === "string" ? step.results.get(block.tool_use_id) : undefined;
			return !!expected && sameToolResult(block, expected);
		});
	}

	/**
	 * Ends the current request. Only a complete answer that stopped for tool use or at the end of its turn
	 * keeps the process; Claude Code continues on its own after other stop reasons.
	 */
	finish(complete: boolean): void {
		this.busy = false;
		const reason = this.answer?.stopReason;
		if (
			this.drifted ||
			!complete ||
			(reason !== "tool_use" && reason !== "end_turn") ||
			!keepsOrder(this.answer?.blocks ?? []) ||
			// Claude Code called a tool the finished answer never asked for.
			this.early.size > 0
		) {
			void this.close();
			return;
		}
		this.armIdleTimer();
	}

	/**
	 * MCP tool handler: answers a held call once lunR's next request brings its result. Claude Code calls a
	 * tool as soon as its block ends, which can be before lunR has read that block or the answer's end; a
	 * call with an unknown id is held while the answer still streams, and `finish` stops the process if the
	 * answer never names it.
	 */
	toolCall = (id: string | undefined): Promise<ClaudeCodeToolResult> => {
		const known = !!id && this.expected.delete(id);
		if (!id || this.closed || (!known && !this.busy)) {
			void this.close();
			return Promise.reject(new Error("Claude Code called a tool lunR did not see"));
		}
		if (!known) this.early.add(id);
		const ready = this.results.get(id);
		this.results.delete(id);
		if (ready) return Promise.resolve(ready);
		return new Promise((resolve, reject) => {
			this.waiting.set(id, (result) => (result ? resolve(result) : reject(new Error("Claude Code session closed"))));
		});
	};

	/** Stops the process tree and releases its loopback and files. Safe to call more than once. */
	close(): Promise<void> {
		this.closing ??= (async () => {
			this.closed = true;
			clearTimeout(this.idle);
			// The kill is sent before held tool calls fail, so Claude Code never sees a failed call and asks again.
			const stopped = stopProcessTree(this.child.pid);
			for (const resolve of this.waiting.values()) resolve(undefined);
			this.waiting.clear();
			await stopped;
			await this.cleanup();
		})();
		return this.closing;
	}

	/** Synchronous kill for process exit, when no promise can settle. */
	kill(): void {
		const pid = this.child.pid;
		if (pid === undefined || this.closed) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			/* Already exited. */
		}
	}

	private armIdleTimer(): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => void this.close(), claudeCodeSessionIdleMs());
		this.idle.unref();
	}
}
