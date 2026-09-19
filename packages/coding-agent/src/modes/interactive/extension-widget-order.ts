import type { Component } from "@earendil-works/pi-tui";

export type ExtensionWidgetComponent = Component & { dispose?(): void };

const BUILTIN_WIDGET_ORDER = new Map([
	["todos", 0],
	["subagent-async", 1],
]);

export function replaceExtensionWidget(
	above: Map<string, ExtensionWidgetComponent>,
	below: Map<string, ExtensionWidgetComponent>,
	key: string,
	component: ExtensionWidgetComponent | undefined,
	placement: "aboveEditor" | "belowEditor",
): void {
	const target = placement === "belowEditor" ? below : above;
	const other = placement === "belowEditor" ? above : below;
	const existingTarget = target.get(key);
	const existingOther = other.get(key);

	if (existingTarget && existingTarget !== component) existingTarget.dispose?.();
	if (existingOther && existingOther !== component) existingOther.dispose?.();
	other.delete(key);

	if (component === undefined) {
		target.delete(key);
		return;
	}
	target.set(key, component);
}

export function orderedExtensionWidgets(
	widgets: ReadonlyMap<string, ExtensionWidgetComponent>,
): Array<[string, ExtensionWidgetComponent]> {
	return [...widgets.entries()]
		.map(([key, component], insertionIndex) => ({ key, component, insertionIndex }))
		.sort((left, right) => {
			const leftOrder = BUILTIN_WIDGET_ORDER.get(left.key);
			const rightOrder = BUILTIN_WIDGET_ORDER.get(right.key);
			if (leftOrder !== undefined || rightOrder !== undefined) {
				return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
			}
			return left.insertionIndex - right.insertionIndex;
		})
		.map(({ key, component }) => [key, component]);
}

export function widgetSeparatorNeedsSpacer(previousKey: string, key: string): boolean {
	return !(previousKey === "todos" && key === "subagent-async");
}
