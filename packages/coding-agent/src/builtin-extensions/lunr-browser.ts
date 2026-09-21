import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ToolRenderContext } from "../core/extensions/types.ts";
import { toolStatusDotFromContext } from "../core/tools/render-utils.ts";
import { onBrowserEnabledChange, readBrowserSettings } from "../core/browser/settings.ts";
import { BROWSER_DESCRIPTION, type BrowserInput, BrowserParams } from "../core/browser/schema.ts";
import type { BrowserSession } from "../core/browser/runtime.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";

const BROWSER_ACTIVITY_TICK_MS = 18;

export type BrowserActivityState = "pending" | "success" | "error";

function browserTarget(input: BrowserInput): string {
	return input.label || input.name || input.role || "an element";
}

export function describeBrowserActivity(input: BrowserInput, state: BrowserActivityState): string {
	const failed = state === "error";
	const pending = state === "pending";
	if (input.action === "navigate") {
		const url = input.url || "the page";
		return failed ? `Failed to open ${url}` : pending ? `Opening ${url}` : `Opened ${url}`;
	}
	if (input.action === "inspect") {
		return failed ? "Failed to inspect the page" : pending ? "Inspecting the page" : "Inspected the page";
	}
	if (input.action === "screenshot") {
		return failed ? "Failed to capture a screenshot" : pending ? "Capturing a screenshot" : "Captured a screenshot";
	}
	if (input.action === "close") {
		return failed ? "Failed to close the browser" : pending ? "Closing the browser" : "Closed the browser";
	}
	if (input.action === "tabs") {
		if (input.operation === "create") {
			const destination = input.url ? ` at ${input.url}` : "";
			return failed
				? `Failed to open a new tab${destination}`
				: pending
					? `Opening a new tab${destination}`
					: `Opened a new tab${destination}`;
		}
		if (input.operation === "select") {
			const tab = input.tab ? ` ${input.tab}` : "";
			return failed ? `Failed to select tab${tab}` : pending ? `Selecting tab${tab}` : `Selected tab${tab}`;
		}
		if (input.operation === "close") {
			const tab = input.tab ? ` ${input.tab}` : "";
			return failed ? `Failed to close tab${tab}` : pending ? `Closing tab${tab}` : `Closed tab${tab}`;
		}
		return failed ? "Failed to list browser tabs" : pending ? "Listing browser tabs" : "Listed browser tabs";
	}

	const target = browserTarget(input);
	if (input.interaction === "fill") {
		return failed ? `Failed to fill ${target}` : pending ? `Filling ${target}` : `Filled ${target}`;
	}
	if (input.interaction === "select") {
		return failed ? `Failed to select an option in ${target}` : pending ? `Selecting an option in ${target}` : `Selected an option in ${target}`;
	}
	if (input.interaction === "check") {
		const verb = input.checked === false ? "uncheck" : "check";
		const active = input.checked === false ? "Unchecking" : "Checking";
		const done = input.checked === false ? "Unchecked" : "Checked";
		return failed ? `Failed to ${verb} ${target}` : pending ? `${active} ${target}` : `${done} ${target}`;
	}
	if (input.interaction === "press") {
		const key = input.value || "a key";
		return failed ? `Failed to press ${key} on ${target}` : pending ? `Pressing ${key} on ${target}` : `Pressed ${key} on ${target}`;
	}
	return failed ? `Failed to click ${target}` : pending ? `Clicking ${target}` : `Clicked ${target}`;
}

class BrowserActivityText extends Text {
	private activity = "";
	private visibleLength = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private format: (text: string) => string = (text) => text;
	private requestRender: () => void = () => {};

	constructor() {
		super("", 0, 0);
	}

	setActivity(activity: string, format: (text: string) => string, animate: boolean, requestRender?: () => void): void {
		this.format = format;
		this.requestRender = requestRender ?? (() => {});
		if (activity === this.activity) {
			this.paint();
			return;
		}
		this.stop();
		this.activity = activity;
		this.visibleLength = animate ? Math.min(1, Array.from(activity).length) : Array.from(activity).length;
		this.paint();
		if (animate && this.visibleLength < Array.from(activity).length) this.schedule();
	}

	dispose(): void {
		this.stop();
	}

	private schedule(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.visibleLength++;
			this.paint();
			this.requestRender();
			if (this.visibleLength < Array.from(this.activity).length) this.schedule();
		}, BROWSER_ACTIVITY_TICK_MS);
		this.timer.unref?.();
	}

	private paint(): void {
		this.setText(this.format(Array.from(this.activity).slice(0, this.visibleLength).join("")));
	}

	private stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

export function renderBrowserActivity(
	args: BrowserInput,
	theme: Theme,
	context: ToolRenderContext<unknown, BrowserInput>,
): Text {
	const component = context.lastComponent instanceof BrowserActivityText
		? context.lastComponent
		: new BrowserActivityText();
	const state: BrowserActivityState = context.isPartial ? "pending" : context.isError ? "error" : "success";
	const activity = describeBrowserActivity(args, state);
	const animate = context.executionStarted || context.result === undefined;
	component.setActivity(
		activity,
		(text) => `${toolStatusDotFromContext(context, theme)} ${theme.fg(state === "error" ? "error" : "toolTitle", text)}`,
		animate,
		context.requestRender,
	);
	return component;
}

export default function browserExtension(pi: ExtensionAPI): void {
	let enabled = readBrowserSettings().enabled;
	let unsubscribe: (() => void) | undefined;
	let session: BrowserSession | undefined;
	let generation = 0;
	const close = async () => {
		generation++;
		const previous = session;
		session = undefined;
		await previous?.close();
	};
	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		await close();
	});
	pi.on("session_start", async () => {
		await close();
		enabled = readBrowserSettings().enabled;
		unsubscribe?.();
		unsubscribe = onBrowserEnabledChange((value) => {
			enabled = value;
			if (!enabled) void close().catch(() => undefined);
		});
	});
	pi.on("agent_end", async (event) => {
		if (event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")) await close();
	});
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: BROWSER_DESCRIPTION,
		parameters: BrowserParams,
		async execute(_id, input, signal) {
			if (!enabled) {
				await close();
				throw new Error("Browser is disabled. The user can enable Browser in /settings.");
			}
			const current = generation;
			const { BrowserSession } = await import("../core/browser/runtime.ts");
			if (current !== generation || signal?.aborted) throw new Error("Browser call cancelled during initialization.");
			session ??= new BrowserSession(readBrowserSettings().allowPrivate);
			return session.run(input, signal);
		},
		renderCall: renderBrowserActivity,
	});
}
