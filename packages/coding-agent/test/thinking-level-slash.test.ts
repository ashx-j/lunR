import { describe, expect, it } from "vitest";
import { wrapThinkingLevelSlashCommands } from "../src/modes/interactive/thinking-level-slash.ts";

describe("wrapThinkingLevelSlashCommands", () => {
	it("hides unsupported thinking-level commands from / autocomplete", async () => {
		const inner = {
			async getSuggestions() {
				return {
					prefix: "/",
					items: [
						{ value: "thinking", label: "thinking" },
						{ value: "low", label: "low" },
						{ value: "xhigh", label: "xhigh" },
						{ value: "model", label: "model" },
					],
				};
			},
			applyCompletion() {
				return { lines: [""], cursorLine: 0, cursorCol: 0 };
			},
		};
		const provider = wrapThinkingLevelSlashCommands(inner, () => ["off", "low", "high"]);
		const result = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		expect(result?.items.map((item) => item.value)).toEqual(["thinking", "low", "model"]);
	});

	it("does not filter /thinking argument completions", async () => {
		const inner = {
			async getSuggestions() {
				return {
					prefix: "",
					items: [
						{ value: "low", label: "low" },
						{ value: "xhigh", label: "xhigh" },
					],
				};
			},
			applyCompletion() {
				return { lines: [""], cursorLine: 0, cursorCol: 0 };
			},
		};
		const provider = wrapThinkingLevelSlashCommands(inner, () => ["low"]);
		const result = await provider.getSuggestions(["/thinking "], 0, 10, {
			signal: new AbortController().signal,
		});
		expect(result?.items.map((item) => item.value)).toEqual(["low", "xhigh"]);
	});
});
