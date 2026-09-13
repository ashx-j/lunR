import { describe, expect, it, vi } from "vitest";
import {
	type ExtensionWidgetComponent,
	orderedExtensionWidgets,
	replaceExtensionWidget,
	widgetSeparatorNeedsSpacer,
} from "../src/modes/interactive/extension-widget-order.ts";

function widget(dispose = vi.fn()): ExtensionWidgetComponent {
	return { render: () => [], invalidate: () => {}, dispose };
}

describe("extension widget ordering", () => {
	it("replaces in place without changing map order", () => {
		const above = new Map<string, ExtensionWidgetComponent>();
		const below = new Map<string, ExtensionWidgetComponent>();
		const first = widget();
		above.set("todos", first);
		above.set("subagent-async", widget());

		const replacement = widget();
		replaceExtensionWidget(above, below, "todos", replacement, "aboveEditor");

		expect([...above.keys()]).toEqual(["todos", "subagent-async"]);
		expect(above.get("todos")).toBe(replacement);
		expect(first.dispose).toHaveBeenCalledOnce();
	});

	it("keeps todos above async subagents for either mount and remount order", () => {
		for (const initialOrder of [
			["todos", "subagent-async"],
			["subagent-async", "todos"],
		]) {
			const above = new Map<string, ExtensionWidgetComponent>();
			const below = new Map<string, ExtensionWidgetComponent>();
			above.set("third-party", widget());
			for (const key of initialOrder) replaceExtensionWidget(above, below, key, widget(), "aboveEditor");

			expect(orderedExtensionWidgets(above).map(([key]) => key)).toEqual(["todos", "subagent-async", "third-party"]);

			for (const key of initialOrder) {
				replaceExtensionWidget(above, below, key, undefined, "aboveEditor");
				replaceExtensionWidget(above, below, key, widget(), "aboveEditor");
			}
			expect(orderedExtensionWidgets(above).map(([key]) => key)).toEqual(["todos", "subagent-async", "third-party"]);
		}
	});

	it("removes only the blank row between todos and async subagents", () => {
		expect(widgetSeparatorNeedsSpacer("todos", "subagent-async")).toBe(false);
		expect(widgetSeparatorNeedsSpacer("todos", "third-party")).toBe(true);
		expect(widgetSeparatorNeedsSpacer("third-party", "subagent-async")).toBe(true);
	});
});
