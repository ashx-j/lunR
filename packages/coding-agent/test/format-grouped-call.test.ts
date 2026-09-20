import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { formatGroupedCall, GroupedCallText, toolGroupTree } from "../src/core/tools/render-utils.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

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

	test("wrapped leaves preserve the rail, indentation, styling, and content on resize", () => {
		const detail = "\u001b[36mlong/path/without/spaces/文件.ts\nsecond\tline of details\u001b[39m";
		const text = new GroupedCallText("", 0, 0);
		for (const role of ["first", "middle", "last"] as const) {
			text.setCall({ role, tree: true, dot: "●", title: "read", detail });
			for (const width of [20, 60, 15, 20]) {
				const rendered = text.render(width);
				expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
				const leaves = role === "first" ? rendered.slice(1) : rendered;
				expect(stripAnsi(leaves[0]).startsWith(role === "last" ? "  └─ " : "  ├─ ")).toBe(true);
				for (const line of leaves.slice(1)) {
					expect(stripAnsi(line).startsWith(role === "last" ? "     " : "  │  ")).toBe(true);
					expect(line).toContain("\u001b[36m");
				}
				expect(
					leaves
						.map((line) => stripAnsi(line).slice(5))
						.join("")
						.replace(/\s/g, ""),
				).toBe(stripAnsi(detail).replace(/\s/g, ""));
			}
		}
	});

	test("singleton, expanded, and plain text updates retain ordinary wrapping", () => {
		const text = new GroupedCallText("", 0, 0);
		for (const call of [
			{ role: "singleton", tree: true },
			{ role: "first", tree: false },
		] as const) {
			const opts = { ...call, dot: "●", title: "bash", detail: "echo a long command with arguments" };
			text.setCall(opts);
			expect(text.render(20)).toEqual(new Text(formatGroupedCall(opts), 0, 0).render(20));
		}
		text.setCall({ role: "middle", tree: true, dot: "●", title: "read", detail: "long filename" });
		text.render(20);
		text.setText("expanded output without a tree");
		expect(text.render(20)).toEqual(new Text("expanded output without a tree", 0, 0).render(20));
	});

	test("toolGroupTree is off only for expanded rows", () => {
		expect(toolGroupTree({ expanded: false, isError: false })).toBe(true);
		expect(toolGroupTree({ expanded: true, isError: false })).toBe(false);
		expect(toolGroupTree({ expanded: false, isError: true })).toBe(true);
		expect(toolGroupTree({ expanded: true, isError: true })).toBe(false);
	});
});
