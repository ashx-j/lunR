import { describe, expect, it, vi } from "vitest";

// Captures each selector's options and its select callback instead of drawing it.
const selectors = vi.hoisted(() => [] as Array<{ options: string[]; onSelect: (option: string) => void }>);
vi.mock("../src/modes/interactive/components/extension-selector.ts", () => ({
	ExtensionSelectorComponent: class {
		constructor(_title: string, options: string[], onSelect: (option: string) => void) {
			selectors.push({ options, onSelect });
		}
	},
}));

import { type ApprovalDialogHost, showToolApprovalDialog } from "../src/modes/interactive/approval-dialogs.ts";

describe("ask mode tool question", () => {
	it("rejects with the typed feedback and marks the call's card rejected", async () => {
		const card = { beginApproval: vi.fn(), endApproval: vi.fn() };
		const host = {
			lastStartedTool: card,
			showSelector: (create: (done: () => void) => unknown) => create(() => {}),
			showExtensionInput: vi.fn(async () => "  use the test fixture  "),
		};
		const pending = showToolApprovalDialog(host as unknown as ApprovalDialogHost, {
			kind: "tool",
			toolName: "bash",
			action: "ask",
			title: "Run bash?",
			detail: "rm -rf build",
			allowSession: false,
		});
		const selector = selectors.at(-1)!;
		expect(selector.options).toEqual(["Approve once", "Reject", "Reject with feedback"]);
		selector.onSelect("Reject with feedback");
		await expect(pending).resolves.toEqual({ decision: "reject", feedback: "use the test fixture" });
		expect(host.showExtensionInput).toHaveBeenCalledWith("Reject bash", "feedback for the agent (optional)");
		expect(card.beginApproval).toHaveBeenCalledOnce();
		expect(card.endApproval).toHaveBeenCalledWith(false);
	});
});
