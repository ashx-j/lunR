import { Container, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { describeBrowserActivity, renderBrowserActivity } from "../src/builtin-extensions/lunr-browser.ts";
import { type BrowserInput, BrowserParams } from "../src/core/browser/schema.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const browserTool: ToolDefinition<typeof BrowserParams> = {
	name: "browser",
	label: "Browser",
	description: "browser test",
	parameters: BrowserParams,
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
	renderCall: renderBrowserActivity,
};

function createComponent(input: BrowserInput): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"browser",
		"browser-1",
		input,
		{},
		browserTool,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
}

function text(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

beforeAll(() => initTheme("moon"));

afterEach(() => {
	vi.useRealTimers();
});

describe("browser activity descriptions", () => {
	it.each([
		[
			{ action: "navigate", url: "https://example.com" },
			"Opened https://example.com",
			"Failed to open https://example.com",
		],
		[{ action: "inspect" }, "Inspected the page", "Failed to inspect the page"],
		[{ action: "act", interaction: "click", role: "button", name: "Save" }, "Clicked Save", "Failed to click Save"],
		[
			{ action: "act", interaction: "fill", label: "Search", value: "lunr" },
			"Filled Search",
			"Failed to fill Search",
		],
		[
			{ action: "act", interaction: "select", label: "Model", value: "fast" },
			"Selected an option in Model",
			"Failed to select an option in Model",
		],
		[
			{ action: "act", interaction: "check", label: "Enabled", checked: true },
			"Checked Enabled",
			"Failed to check Enabled",
		],
		[
			{ action: "act", interaction: "press", role: "button", name: "Save", value: "Enter" },
			"Pressed Enter on Save",
			"Failed to press Enter on Save",
		],
		[{ action: "tabs", operation: "list" }, "Listed browser tabs", "Failed to list browser tabs"],
		[
			{ action: "tabs", operation: "create", url: "https://example.com" },
			"Opened a new tab at https://example.com",
			"Failed to open a new tab at https://example.com",
		],
		[{ action: "tabs", operation: "select", tab: 2 }, "Selected tab 2", "Failed to select tab 2"],
		[{ action: "tabs", operation: "close", tab: 2 }, "Closed tab 2", "Failed to close tab 2"],
		[{ action: "screenshot" }, "Captured a screenshot", "Failed to capture a screenshot"],
		[{ action: "close" }, "Closed the browser", "Failed to close the browser"],
	] as const)("describes $0 without backend action names", (input, success, failure) => {
		expect(describeBrowserActivity(input as BrowserInput, "success")).toBe(success);
		expect(describeBrowserActivity(input as BrowserInput, "error")).toBe(failure);
	});
});

describe("browser activity card", () => {
	it("reuses one card, replaces its action with a character animation, and hides failures", () => {
		vi.useFakeTimers();
		const component = createComponent({ action: "navigate", url: "https://example.com" });
		const workflow = new Container();
		workflow.addChild(component);
		component.markExecutionStarted();
		expect(text(component)).not.toContain("Opening https://example.com");
		vi.runAllTimers();
		expect(text(component)).toContain("Opening https://example.com");

		component.updateResult({ content: [{ type: "text", text: "backend navigation result" }], isError: false });
		vi.runAllTimers();
		expect(text(component)).toContain("Opened https://example.com");
		expect(text(component)).not.toContain("backend navigation result");

		component.beginNextExecution("browser-2", { action: "inspect" });
		expect(workflow.children).toHaveLength(1);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "private diagnostic dump" }], isError: true });
		vi.runAllTimers();
		expect(text(component)).toContain("Failed to inspect the page");
		expect(text(component)).not.toContain("private diagnostic dump");
		expect(component.handleClick(0, 120)).toBe(false);
		component.setExpanded(true);
		expect(text(component)).not.toContain("private diagnostic dump");
	});

	it("reconstructs completed history immediately without replaying animation", () => {
		vi.useFakeTimers();
		const component = createComponent({ action: "screenshot" });
		component.updateResult({ content: [{ type: "text", text: "saved screenshot" }], isError: false });
		expect(text(component)).toContain("Captured a screenshot");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears its animation timer when disposed", () => {
		vi.useFakeTimers();
		const component = createComponent({ action: "navigate", url: "https://example.com" });
		component.markExecutionStarted();
		expect(vi.getTimerCount()).toBeGreaterThan(0);
		component.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});
});
