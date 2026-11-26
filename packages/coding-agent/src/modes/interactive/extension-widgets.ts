/**
 * The extension widget areas above and below the editor (`ctx.ui.setWidget`). ExtensionWidgets
 * owns both containers and the widgets in them; InteractiveMode adds the containers to the screen
 * in `init` and supplies the TUI through ExtensionWidgetsHost.
 */

import { type Component, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionWidgetOptions } from "../../core/extensions/index.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import {
	orderedExtensionWidgets,
	replaceExtensionWidget,
	widgetSeparatorNeedsSpacer,
} from "./extension-widget-order.ts";
import { type Theme, theme } from "./theme/theme.ts";

/** What the widget areas need from InteractiveMode. InteractiveMode builds one in `createExtensionWidgetsHost`. */
export interface ExtensionWidgetsHost {
	readonly ui: TUI;
}

/** The widgets extensions placed above and below the editor. InteractiveMode owns one. */
export class ExtensionWidgets {
	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;
	/** The area above the editor; the chat stays pinned from here down. */
	readonly above = new Container();
	readonly below = new Container();
	private readonly host: ExtensionWidgetsHost;
	private _aboveWidgets = new Map<string, Component & { dispose?(): void }>();
	private _belowWidgets = new Map<string, Component & { dispose?(): void }>();

	constructor(host: ExtensionWidgetsHost) {
		this.host = host;
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	set(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		let component: (Component & { dispose?(): void }) | undefined;

		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, ExtensionWidgets.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > ExtensionWidgets.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else if (content) {
			component = content(this.host.ui, theme);
		}

		replaceExtensionWidget(this._aboveWidgets, this._belowWidgets, key, component, placement);
		this.render();
	}

	/** Disposes and removes every widget, as a session replacement does. */
	clear(): void {
		for (const widget of this._aboveWidgets.values()) {
			widget.dispose?.();
		}
		for (const widget of this._belowWidgets.values()) {
			widget.dispose?.();
		}
		this._aboveWidgets.clear();
		this._belowWidgets.clear();
		this.render();
	}

	/**
	 * Render all extension widgets to the widget container.
	 */
	render(): void {
		if (!this.above || !this.below) return;
		this._renderContainer(this.above, this._aboveWidgets, true, true);
		this._renderContainer(this.below, this._belowWidgets, false, false);
		this.host.ui.requestRender();
	}

	private _renderContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		let previousKey: string | undefined;
		for (const [key, component] of orderedExtensionWidgets(widgets)) {
			if (previousKey !== undefined) {
				if (widgetSeparatorNeedsSpacer(previousKey, key)) container.addChild(new Spacer(1));
				container.addChild(new DynamicBorder((s) => theme.fg("dim", s)));
			}
			previousKey = key;
			container.addChild(component);
		}
	}
}
