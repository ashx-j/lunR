import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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
 * Stops a process that sat unused this long. Matches the 1h prompt cache TTL Claude Code writes: while the
 * cache lives, the kept process saves a restart and the history rewrite a restart costs; after it expires a
 * restart costs nothing extra.
 */
export const CLAUDE_CODE_SESSION_IDLE_MS = 60 * 60 * 1000;
/** Claude Code saves larger tool results to a file and sends a preview; those turns restart instead. */
const MAX_TOOL_RESULT_CHARS = 400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The MCP answer that makes Claude Code record exactly `block` as its tool result, or undefined when that
 * is not certain. Measured on 2.1.310: one text item comes back as a one-block text array (the same prompt
 * as lunR's string), and an error comes back as the joined string with `is_error`. Images and empty text
 * are left to a restart.
 */
function toolResult(block: Block): ClaudeCodeToolResult | undefined {
	const keys = Object.keys(block).filter((key) => key !== "is_error");
	if (keys.length !== 3 || !keys.includes("tool_use_id") || !keys.includes("content")) return undefined;
	if (typeof block.content !== "string" || !block.content || block.content.length > MAX_TOOL_RESULT_CHARS)
		return undefined;
	if (block.is_error !== undefined && typeof block.is_error !== "boolean") return undefined;
	const content = [{ type: "text" as const, text: block.content }];
	return block.is_error ? { content, isError: true } : { content };
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
	closed = false;

	private readonly child: ChildProcessWithoutNullStreams;
	private readonly cleanup: () => Promise<void>;
	/** The frames Claude Code holds, in the bridge's shape. Empty until the first step. */
	private held: SessionFrame[] = [];
	private started = false;
	/** The answer streamed for the last request; lunR's next request must carry it unchanged. */
	private answer: StreamedAnswer | undefined;
	/** Tool calls the last answer asked for that Claude Code has not made yet. */
	private readonly expected = new Set<unknown>();
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
		if (!answer || history.length !== held + 2) return undefined;
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

	/** Records one raw stream event of the current answer. */
	observe(event: Record<string, unknown>): void {
		this.answer?.add(event);
	}

	/**
	 * Checks a `user` line Claude Code printed while it ran the current step: a tool result it recorded must
	 * be the one lunR sent. False means the held copy drifted from lunR's history.
	 */
	verify(event: ClaudeCodeEvent, step: SessionStep): boolean {
		if (step.kind !== "tools" || event.type !== "user" || !isRecord(event.message)) return true;
		const content = Array.isArray(event.message.content) ? event.message.content : [];
		return content.every((block) => {
			if (!isRecord(block) || block.type !== "tool_result") return true;
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
		if (!complete || (reason !== "tool_use" && reason !== "end_turn")) {
			void this.close();
			return;
		}
		for (const block of this.answer?.blocks ?? []) if (block.type === "tool_use") this.expected.add(block.id);
		this.armIdleTimer();
	}

	/** MCP tool handler: answers a held call once lunR's next request brings its result. */
	toolCall = (id: string | undefined): Promise<ClaudeCodeToolResult> => {
		if (!id || !this.expected.delete(id)) {
			void this.close();
			return Promise.reject(new Error("Claude Code called a tool lunR did not see"));
		}
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
		this.idle = setTimeout(() => void this.close(), CLAUDE_CODE_SESSION_IDLE_MS);
		this.idle.unref();
	}
}
