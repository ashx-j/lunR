import { describe, expect, it } from "vitest";
import { searchTexts } from "../src/utils/regex-worker.ts";

describe("regex worker", () => {
	it("measures only the match, so a new worker's start-up never stops an ordinary search", async () => {
		const catastrophic = [`${"a".repeat(40)}!`];
		for (let round = 0; round < 3; round++) {
			// Each round starts a new worker, since the catastrophic search terminates the old one.
			expect(await searchTexts("^b", "", ["ab", "ba"], 5)).toEqual({ kind: "done", indexes: [-1, 0] });
			expect(await searchTexts("(a+)+$", "", catastrophic, 50)).toEqual({ kind: "timeout" });
		}
	});
});
