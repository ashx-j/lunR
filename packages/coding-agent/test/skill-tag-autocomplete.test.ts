import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { extractSkillTagPrefix, wrapSkillTagAutocomplete } from "../src/modes/interactive/skill-tag-autocomplete.ts";

const skills = [
	{ name: "pdf-tools", description: "PDF helpers" },
	{ name: "brave-search", description: "Web search" },
];

function createInner(overrides?: Partial<AutocompleteProvider>): AutocompleteProvider & {
	getSuggestions: ReturnType<typeof vi.fn>;
	applyCompletion: ReturnType<typeof vi.fn>;
} {
	const inner = {
		getSuggestions: vi.fn(async () => ({
			items: [{ value: "delegated", label: "delegated" }],
			prefix: "delegated",
		})),
		applyCompletion: vi.fn((lines: string[], cursorLine: number, cursorCol: number) => ({
			lines,
			cursorLine,
			cursorCol,
		})),
		shouldTriggerFileCompletion: vi.fn(() => true),
		...overrides,
	};
	return inner;
}

const abort = { signal: new AbortController().signal };

describe("extractSkillTagPrefix", () => {
	it("matches a tag after a space but not glued to the previous word", () => {
		expect(extractSkillTagPrefix("hello +", "+")).toBe("+");
		expect(extractSkillTagPrefix("hello +pdf", "+")).toBe("+pdf");
		expect(extractSkillTagPrefix("hello+", "+")).toBeNull();
		expect(extractSkillTagPrefix("xyz+pdf", "+")).toBeNull();
	});

	it("matches at the start of a line and after a tab", () => {
		expect(extractSkillTagPrefix("+", "+")).toBe("+");
		expect(extractSkillTagPrefix("+pdf", "+")).toBe("+pdf");
		expect(extractSkillTagPrefix("hello\t+pdf", "+")).toBe("+pdf");
	});

	it("ignores slash-command lines and home-path tokens", () => {
		expect(extractSkillTagPrefix("/skill:pdf +", "+")).toBeNull();
		expect(extractSkillTagPrefix("~/src", "~")).toBeNull();
		expect(extractSkillTagPrefix("~\\src", "~")).toBeNull();
		expect(extractSkillTagPrefix("~pdf", "~")).toBe("~pdf");
	});
});

describe("wrapSkillTagAutocomplete", () => {
	it("lists skills after a space and at the start of a line", async () => {
		const provider = wrapSkillTagAutocomplete(createInner(), { character: "+", skills });

		const afterSpace = await provider.getSuggestions(["hello +"], 0, "hello +".length, abort);
		expect(afterSpace?.items.map((item) => item.value)).toEqual(["+pdf-tools", "+brave-search"]);
		expect(afterSpace?.prefix).toBe("+");

		const atStart = await provider.getSuggestions(["+"], 0, 1, abort);
		expect(atStart?.items.map((item) => item.label)).toEqual(["pdf-tools", "brave-search"]);
	});

	it("does not list skills when the character is glued to the previous word", async () => {
		const inner = createInner();
		const provider = wrapSkillTagAutocomplete(inner, { character: "+", skills });
		const suggestions = await provider.getSuggestions(["hello+"], 0, "hello+".length, abort);
		expect(inner.getSuggestions).toHaveBeenCalledOnce();
		expect(suggestions?.items).toEqual([{ value: "delegated", label: "delegated" }]);
	});

	it("fuzzy-filters by skill name", async () => {
		const provider = wrapSkillTagAutocomplete(createInner(), { character: "+", skills });
		const suggestions = await provider.getSuggestions(["Please use +pdf"], 0, "Please use +pdf".length, abort);
		expect(suggestions?.items.map((item) => item.value)).toEqual(["+pdf-tools"]);
		expect(suggestions?.prefix).toBe("+pdf");
	});

	it("inserts the tag and a trailing space without dropping surrounding text", () => {
		const inner = createInner();
		const provider = wrapSkillTagAutocomplete(inner, { character: "+", skills });
		const result = provider.applyCompletion(
			["Please use +pdf now"],
			0,
			"Please use +pdf".length,
			{ value: "+pdf-tools", label: "pdf-tools" },
			"+pdf",
		);
		expect(result.lines[0]).toBe("Please use +pdf-tools  now");
		expect(result.cursorCol).toBe("Please use +pdf-tools ".length);
		expect(inner.applyCompletion).not.toHaveBeenCalled();
	});

	it("delegates ~/ path tokens when the tag character is ~", async () => {
		const inner = createInner();
		const provider = wrapSkillTagAutocomplete(inner, { character: "~", skills });
		await provider.getSuggestions(["open ~/src"], 0, "open ~/src".length, abort);
		expect(inner.getSuggestions).toHaveBeenCalledOnce();
	});

	it("delegates lines that start with a slash command", async () => {
		const inner = createInner();
		const provider = wrapSkillTagAutocomplete(inner, { character: "+", skills });
		await provider.getSuggestions(["/model +"], 0, "/model +".length, abort);
		expect(inner.getSuggestions).toHaveBeenCalledOnce();
	});

	it("only matches the configured tag character", async () => {
		const inner = createInner();
		const dollar = wrapSkillTagAutocomplete(inner, { character: "$", skills });
		const plusSuggestions = await dollar.getSuggestions(["hello +"], 0, "hello +".length, abort);
		expect(inner.getSuggestions).toHaveBeenCalledOnce();
		expect(plusSuggestions?.items[0]?.value).toBe("delegated");

		const dollarSuggestions = await dollar.getSuggestions(["hello $pdf"], 0, "hello $pdf".length, abort);
		expect(dollarSuggestions?.items.map((item) => item.value)).toEqual(["$pdf-tools"]);
	});

	it("returns null when no skills match", async () => {
		const provider = wrapSkillTagAutocomplete(createInner(), { character: "+", skills });
		const suggestions = await provider.getSuggestions(["+zzz"], 0, 4, abort);
		expect(suggestions).toBeNull();
	});
});
