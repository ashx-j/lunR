import { describe, expect, it } from "vitest";
import { formatChipEffort, thinkingThemeToken } from "../src/builtin-extensions/ashxj-tui.ts";

describe("ashxj-tui thinking chip", () => {
	it("prints xhigh and max without mapping them down to high", () => {
		expect(formatChipEffort("high")).toBe("high");
		expect(formatChipEffort("xhigh")).toBe("xhigh");
		expect(formatChipEffort("max")).toBe("max");
		expect(formatChipEffort("off")).toBe("off");
	});

	it("maps each level to its thinking theme token", () => {
		expect(thinkingThemeToken("off")).toBe("thinkingOff");
		expect(thinkingThemeToken("minimal")).toBe("thinkingMinimal");
		expect(thinkingThemeToken("low")).toBe("thinkingLow");
		expect(thinkingThemeToken("medium")).toBe("thinkingMedium");
		expect(thinkingThemeToken("high")).toBe("thinkingHigh");
		expect(thinkingThemeToken("xhigh")).toBe("thinkingXhigh");
		expect(thinkingThemeToken("max")).toBe("thinkingMax");
	});
});
