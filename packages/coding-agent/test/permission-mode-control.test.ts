import { describe, expect, it } from "vitest";
import { nextModeForGoal } from "../src/core/permission-mode-control.ts";

describe("nextModeForGoal", () => {
	it("keeps yolo and auto as they are for the goal", () => {
		expect(nextModeForGoal("yolo", "enter", undefined)).toEqual({ mode: "yolo", saved: undefined });
		expect(nextModeForGoal("auto", "enter", undefined)).toEqual({ mode: "auto", saved: undefined });
		expect(nextModeForGoal("auto", "leave", undefined)).toEqual({ mode: "auto", saved: undefined });
	});

	it("leaves read-only for yolo during the goal and restores it after", () => {
		const entered = nextModeForGoal("read-only", "enter", undefined);
		expect(entered).toEqual({ mode: "yolo", saved: "read-only" });
		expect(nextModeForGoal("yolo", "leave", entered.saved)).toEqual({ mode: "read-only", saved: undefined });
	});

	it("does not override a user switch to auto during the goal", () => {
		const entered = nextModeForGoal("read-only", "enter", undefined);
		expect(nextModeForGoal("auto", "leave", entered.saved)).toEqual({ mode: "auto", saved: undefined });
	});

	it("re-entering during a goal keeps the saved mode", () => {
		const entered = nextModeForGoal("read-only", "enter", undefined);
		expect(nextModeForGoal("yolo", "enter", entered.saved)).toEqual({ mode: "yolo", saved: "read-only" });
	});
});
