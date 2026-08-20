import { describe, expect, it, vi } from "vitest";
import ashxjThinking from "../src/builtin-extensions/ashxj-thinking.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?(prefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler(args: string, ctx: CommandCtx): Promise<void> | void;
}

interface CommandCtx {
	mode: "tui" | "rpc" | "json" | "print";
	model: { id?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } | undefined;
	ui: {
		notify: ReturnType<typeof vi.fn>;
		select: ReturnType<typeof vi.fn>;
	};
	getThinkingLevel(): ThinkingLevel;
	reload: ReturnType<typeof vi.fn>;
}

function setup(
	options: { level?: ThinkingLevel; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } = {},
) {
	const commands = new Map<string, RegisteredCommand>();
	let level: ThinkingLevel = options.level ?? "off";
	const notify = vi.fn();
	const select = vi.fn();
	const reload = vi.fn(async () => {});
	const setThinkingLevel = vi.fn((next: ThinkingLevel) => {
		level = next;
	});
	const model = {
		id: "claude-opus-4",
		reasoning: options.reasoning ?? true,
		thinkingLevelMap: options.thinkingLevelMap,
	};

	const pi = {
		registerCommand(name: string, spec: RegisteredCommand) {
			commands.set(name, spec);
		},
		getThinkingLevel: () => level,
		setThinkingLevel,
		getModel: () => model,
	};

	ashxjThinking(pi);

	const ctx: CommandCtx = {
		mode: "print",
		model,
		ui: { notify, select },
		getThinkingLevel: () => level,
		reload,
	};

	return { commands, pi, ctx, notify, select, setThinkingLevel };
}

describe("ashxj-thinking", () => {
	it("registers /thinking, /effort, and /reasoning", () => {
		const { commands } = setup();
		expect([...commands.keys()]).toEqual(["thinking", "effort", "reasoning"]);
		expect(commands.get("thinking")?.description).toContain("reasoning level");
		expect(commands.get("effort")?.description).toContain("alias of /thinking");
		expect(commands.get("reasoning")?.description).toContain("alias of /thinking");
	});

	it("completions have no token-budget copy", () => {
		const { commands } = setup();
		for (const name of ["thinking", "effort", "reasoning"]) {
			const items = commands.get(name)!.getArgumentCompletions!("");
			expect(Array.isArray(items)).toBe(true);
			const blob = JSON.stringify(items);
			expect(blob).not.toMatch(/~\d+k tokens/i);
			expect(blob.toLowerCase()).not.toContain("token");
			const values = (items as AutocompleteItem[]).map((item) => item.value);
			expect(values).toEqual(expect.arrayContaining(["show", "hide", "toggle", "off", "low", "high"]));
			expect(values).not.toContain("xhigh");
			expect(values).not.toContain("max");
		}
	});

	it("completions include xhigh and max only when the model map opts in", () => {
		const { commands } = setup({ thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		for (const name of ["thinking", "effort", "reasoning"]) {
			const values = (commands.get(name)!.getArgumentCompletions!("") as AutocompleteItem[]).map(
				(item) => item.value,
			);
			expect(values).toEqual(expect.arrayContaining(["xhigh", "max", "high"]));
		}
	});

	it("completions include max but not xhigh when the map has a hole", () => {
		const { commands } = setup({ thinkingLevelMap: { xhigh: null, max: "max" } });
		const values = (commands.get("thinking")!.getArgumentCompletions!("") as AutocompleteItem[]).map(
			(item) => item.value,
		);
		expect(values).toContain("max");
		expect(values).not.toContain("xhigh");
	});

	it.each(["thinking", "effort", "reasoning"] as const)("/%s high sets the thinking level", async (name) => {
		const { commands, ctx, setThinkingLevel, notify } = setup();
		await commands.get(name)!.handler("high", ctx);
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
		expect(notify).toHaveBeenCalledWith("Thinking level: high", "info");
	});

	it("rejects invalid levels", async () => {
		const { commands, ctx, setThinkingLevel, notify } = setup();
		await commands.get("thinking")!.handler("maximum", ctx);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid thinking level: "maximum"'), "error");
	});

	it("rejects xhigh on a model that does not opt in", async () => {
		const { commands, ctx, setThinkingLevel, notify } = setup();
		await commands.get("thinking")!.handler("xhigh", ctx);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining('Invalid thinking level: "xhigh"'), "error");
		const valid = String(notify.mock.calls[0][0]).split("Valid: ")[1] ?? "";
		expect(valid.split(", ")).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	it.each(["thinking", "effort", "reasoning"] as const)("/%s xhigh sets the level when opted in", async (name) => {
		const { commands, ctx, setThinkingLevel, notify } = setup({
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		await commands.get(name)!.handler("xhigh", ctx);
		expect(setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(notify).toHaveBeenCalledWith("Thinking level: xhigh", "info");
	});

	it("/thinking max sets the level when opted in", async () => {
		const { commands, ctx, setThinkingLevel, notify } = setup({
			thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		});
		await commands.get("thinking")!.handler("max", ctx);
		expect(setThinkingLevel).toHaveBeenCalledWith("max");
		expect(notify).toHaveBeenCalledWith("Thinking level: max", "info");
	});

	it("no-arg in non-TUI reports the current level", async () => {
		const { commands, ctx, notify, select } = setup({ level: "medium" });
		await commands.get("effort")!.handler("", ctx);
		expect(notify).toHaveBeenCalledWith("Thinking level: medium", "info");
		expect(select).not.toHaveBeenCalled();
	});
});
