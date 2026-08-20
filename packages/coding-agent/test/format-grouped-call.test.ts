import { describe, expect, test } from "vitest";
import { formatGroupedCall } from "../src/core/tools/render-utils.ts";

describe("formatGroupedCall", () => {
	test("singletons keep verb and detail on one line", () => {
		expect(
			formatGroupedCall({
				role: "singleton",
				compact: true,
				dot: "●",
				title: "read",
				detail: "resolve.ts",
			}),
		).toBe("● read resolve.ts");
	});

	test("first of a compact group prints the verb then a mid branch", () => {
		expect(
			formatGroupedCall({
				role: "first",
				compact: true,
				dot: "●",
				title: "read",
				detail: "resolve.ts",
			}),
		).toBe("● read\n  ├─ resolve.ts");
	});

	test("middle and last compact rows are branch-only", () => {
		expect(
			formatGroupedCall({
				role: "middle",
				compact: true,
				dot: "●",
				title: "read",
				detail: "model-runtime.ts",
			}),
		).toBe("  ├─ model-runtime.ts");
		expect(
			formatGroupedCall({
				role: "last",
				compact: true,
				dot: "●",
				title: "read",
				detail: "usage-service.ts",
			}),
		).toBe("  └─ usage-service.ts");
	});

	test("non-compact grouped rows keep the full one-line header", () => {
		expect(
			formatGroupedCall({
				role: "first",
				compact: false,
				dot: "●",
				title: "read",
				detail: "resolve.ts",
			}),
		).toBe("● read resolve.ts");
	});
});
