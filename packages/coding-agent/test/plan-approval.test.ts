import { beforeEach, describe, expect, it } from "vitest";
import { PRESENT_PLAN_WRONG_MODE_TEXT, runPresentPlan } from "../src/builtin-extensions/lunr-plan-tools.ts";
import {
	type ApprovalRequest,
	type ApprovalResponse,
	isPlanModeActive,
	NO_HANDLER_REASON,
	PLAN_APPROVED_TEXT,
	PLAN_DECLINED_TEXT,
	PLAN_PASS_THROUGH_TEXT,
	planApprovalResultText,
	registerApprovalHandler,
	requestPlanApproval,
	resetAllPermissionContexts,
	setPermissionMode,
} from "../src/core/permissions.ts";

describe("planApprovalResultText", () => {
	it("maps bare approve decisions to the approved text", () => {
		expect(planApprovalResultText("once")).toBe(PLAN_APPROVED_TEXT);
		expect(planApprovalResultText("session")).toBe(PLAN_APPROVED_TEXT);
		expect(planApprovalResultText({ decision: "approve" })).toBe(PLAN_APPROVED_TEXT);
	});

	it("maps approve with feedback", () => {
		expect(planApprovalResultText({ decision: "approve", feedback: "skip step 2" })).toBe(
			"Plan approved with feedback: skip step 2 — implement it now.",
		);
	});

	it("maps bare reject to the declined text", () => {
		expect(planApprovalResultText("reject")).toBe(PLAN_DECLINED_TEXT);
	});

	it("maps reject with feedback", () => {
		expect(planApprovalResultText({ decision: "reject", feedback: "too risky" })).toBe(
			"Plan declined: too risky — revise the plan and call present_plan again.",
		);
	});

	it("trims feedback and ignores blank feedback", () => {
		expect(planApprovalResultText({ decision: "approve", feedback: "  " })).toBe(PLAN_APPROVED_TEXT);
		expect(planApprovalResultText({ decision: "reject", feedback: "  no  " })).toBe(
			"Plan declined: no — revise the plan and call present_plan again.",
		);
	});
});

describe("requestPlanApproval", () => {
	beforeEach(() => {
		resetAllPermissionContexts();
		registerApprovalHandler(undefined);
	});

	it("passes through when no approval handler is registered (headless)", async () => {
		expect(await requestPlanApproval("do the thing")).toBe(PLAN_PASS_THROUGH_TEXT);
	});

	it("passes through when the handler reports no approval channel", async () => {
		registerApprovalHandler(async () => {
			throw new Error(NO_HANDLER_REASON);
		});
		expect(await requestPlanApproval("do the thing")).toBe(PLAN_PASS_THROUGH_TEXT);
	});

	it("sends a kind:plan request with the summary as detail", async () => {
		let received: ApprovalRequest | undefined;
		registerApprovalHandler(async (req) => {
			received = req;
			return { decision: "approve" } as ApprovalResponse;
		});
		expect(await requestPlanApproval("refactor the foo module")).toBe(PLAN_APPROVED_TEXT);
		expect(received?.kind).toBe("plan");
		expect(received?.action).toBe("plan");
		expect(received?.toolName).toBe("present_plan");
		expect(received?.detail).toBe("refactor the foo module");
	});

	it("maps approve/decline responses to result text", async () => {
		registerApprovalHandler(async () => ({ decision: "approve", feedback: "go, but keep tests" }));
		expect(await requestPlanApproval("x")).toBe(
			"Plan approved with feedback: go, but keep tests — implement it now.",
		);

		registerApprovalHandler(async () => "reject" as ApprovalResponse);
		expect(await requestPlanApproval("x")).toBe(PLAN_DECLINED_TEXT);
	});

	it("a throwing handler (other than no-channel) declines with the message", async () => {
		registerApprovalHandler(async () => {
			throw new Error("dialog exploded");
		});
		expect(await requestPlanApproval("x")).toBe(
			"Plan declined: dialog exploded — revise the plan and call present_plan again.",
		);
	});
});

describe("present_plan tool (runPresentPlan)", () => {
	beforeEach(() => {
		resetAllPermissionContexts();
		registerApprovalHandler(undefined);
		setPermissionMode("manual");
	});

	it("errors outside plan mode", async () => {
		expect(isPlanModeActive()).toBe(false);
		expect(await runPresentPlan("anything")).toBe(PRESENT_PLAN_WRONG_MODE_TEXT);
	});

	it("passes through in plan mode without a handler", async () => {
		setPermissionMode("plan");
		expect(await runPresentPlan("my plan")).toBe(PLAN_PASS_THROUGH_TEXT);
	});

	it("returns the approval result text in plan mode with a handler", async () => {
		setPermissionMode("plan");
		registerApprovalHandler(async () => ({ decision: "approve" }));
		expect(await runPresentPlan("my plan")).toBe(PLAN_APPROVED_TEXT);
	});
});
