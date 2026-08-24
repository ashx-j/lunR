import { describe, expect, test } from "vitest";
import { formatGroupedCall, toolGroupTree } from "../src/core/tools/render-utils.ts";

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

	test("compact: false without tree keeps the full one-line header", () => {
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

	test("still-running grouped rows tree when tree is true", () => {
		expect(
			formatGroupedCall({
				role: "first",
				compact: false,
				tree: true,
				dot: "●",
				title: "read",
				detail: "resolve.ts",
			}),
		).toBe("● read\n  ├─ resolve.ts");
		expect(
			formatGroupedCall({
				role: "last",
				compact: false,
				tree: true,
				dot: "●",
				title: "read",
				detail: "usage-service.ts",
			}),
		).toBe("  └─ usage-service.ts");
	});

	test("toolGroupTree is off only for expanded rows", () => {
		expect(toolGroupTree({ expanded: false, isError: false })).toBe(true);
		expect(toolGroupTree({ expanded: true, isError: false })).toBe(false);
		expect(toolGroupTree({ expanded: false, isError: true })).toBe(true);
		expect(toolGroupTree({ expanded: true, isError: true })).toBe(false);
	});
});
