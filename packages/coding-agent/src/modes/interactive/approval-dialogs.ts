/**
 * The approval questions interactive mode asks for the permission layer: ask mode's question
 * before a tool call, the large subagent launch check, and present_plan's plan approval.
 * InteractiveMode registers them with `registerApprovalHandler` and supplies the UI through
 * ApprovalDialogHost.
 */

import { type Component, type Container, type MarkdownTheme, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { ApprovalRequest, ApprovalResponse } from "../../core/permissions.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { PlanMessageComponent } from "./components/plan-message.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/** What the approval dialogs need from InteractiveMode. InteractiveMode builds one in `createApprovalDialogHost`. */
export interface ApprovalDialogHost {
	readonly ui: TUI;
	readonly chatContainer: Container;
	/** The tool card whose `tool_execution_start` came last; ask mode's question belongs to it. */
	readonly lastStartedTool: ToolExecutionComponent | undefined;
	readonly outputPad: number;
	/** The markdown theme with the user's code block indent applied. */
	getMarkdownTheme(): MarkdownTheme;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showExtensionInput(title: string, placeholder?: string): Promise<string | undefined>;
}

// Approval dialog for one subagent call launching more than two children, and for ask mode's
// question before one call (`title`; no session answer when `allowSession` is false; "Always
// allow" when the request carries a `rule`). "Reject with feedback" collects a one-line
// reason that becomes the block reason the model sees, so it can adjust the plan.
export async function showToolApprovalDialog(
	host: ApprovalDialogHost,
	req: ApprovalRequest,
): Promise<ApprovalResponse> {
	// Ask mode's question belongs to the call that started last. Its card leaves the time spent
	// deciding out of "Took" and says "rejected" in words.
	const card = req.kind === "tool" ? host.lastStartedTool : undefined;
	card?.beginApproval();
	const response = await askToolApproval(host, req);
	card?.endApproval((typeof response === "string" ? response : response.decision) !== "reject");
	return response;
}

function askToolApproval(host: ApprovalDialogHost, req: ApprovalRequest): Promise<ApprovalResponse> {
	const always = req.rule ? `Always allow in every project (saves ${req.rule} to global settings)` : undefined;
	return new Promise((resolve) => {
		host.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				req.title ?? "Approve large subagent launch?",
				[
					"Approve once",
					...(req.allowSession === false ? [] : ["Approve for this session"]),
					...(always ? [always] : []),
					"Reject",
					"Reject with feedback",
				],
				(option) => {
					done();
					if (option === "Approve once") resolve("once");
					else if (option === "Approve for this session") resolve("session");
					else if (option === always) resolve("always");
					else if (option === "Reject with feedback") {
						void host
							.showExtensionInput(
								req.kind === "tool" ? `Reject ${req.toolName}` : "Reject large subagent launch",
								"feedback for the agent (optional)",
							)
							.then((feedback) => {
								const trimmed = feedback?.trim();
								resolve(trimmed ? { decision: "reject", feedback: trimmed } : "reject");
							});
					} else resolve("reject");
				},
				() => {
					done();
					resolve("reject");
				},
				{ message: req.detail.slice(0, 500) },
			);
			return { component: selector, focus: selector };
		});
	});
}

function showPlanInChat(host: ApprovalDialogHost, summary: string): void {
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new PlanMessageComponent(summary, host.getMarkdownTheme(), host.outputPad));
	host.ui.requestRender();
}

// Approval dialog for present_plan (read-only mode). The "with feedback"
// options collect a one-line note via showExtensionInput that becomes part of
// the result text the model sees. Esc/close counts as Decline.
export async function showPlanApprovalDialog(host: ApprovalDialogHost, summary: string): Promise<ApprovalResponse> {
	showPlanInChat(host, summary);
	return new Promise((resolve) => {
		host.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"▶ Approve plan?",
				["Approve", "Approve with feedback", "Decline", "Decline with feedback"],
				(option) => {
					done();
					if (option === "Approve") resolve({ decision: "approve" });
					else if (option === "Approve with feedback") {
						void host.showExtensionInput("Approve plan", "feedback for the agent (optional)").then((feedback) => {
							const trimmed = feedback?.trim();
							resolve(trimmed ? { decision: "approve", feedback: trimmed } : { decision: "approve" });
						});
					} else if (option === "Decline with feedback") {
						void host.showExtensionInput("Decline plan", "feedback for the agent (optional)").then((feedback) => {
							const trimmed = feedback?.trim();
							resolve(trimmed ? { decision: "reject", feedback: trimmed } : "reject");
						});
					} else resolve("reject");
				},
				() => {
					done();
					resolve("reject");
				},
			);
			return { component: selector, focus: selector };
		});
	});
}
