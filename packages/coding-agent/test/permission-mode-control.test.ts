import { describe, expect, it } from "vitest";
import { nextModeForGoal } from "../src/core/permission-mode-control.ts";

describe("nextModeForGoal", () => {
	it("enters auto from manual and restores manual on leave", () => {
		const entered = nextModeForGoal("manual", "enter", undefined);
		expect(entered).toEqual({ mode: "auto", saved: "manual" });
		expect(nextModeForGoal("auto", "leave", entered.saved)).toEqual({ mode: "manual", saved: undefined });
	});

	it("stays auto when already auto and leave keeps auto", () => {
		const entered = nextModeForGoal("auto", "enter", undefined);
		expect(entered).toEqual({ mode: "auto", saved: undefined });
		expect(nextModeForGoal("auto", "leave", entered.saved)).toEqual({ mode: "auto", saved: undefined });
	});

	it("does not override a user switch to yolo during the goal", () => {
		const entered = nextModeForGoal("manual", "enter", undefined);
		expect(nextModeForGoal("yolo", "leave", entered.saved)).toEqual({ mode: "yolo", saved: undefined });
	});

	it("re-enter after a mid-goal yolo switch stays yolo", () => {
		const entered = nextModeForGoal("manual", "enter", undefined);
		expect(nextModeForGoal("yolo", "enter", entered.saved)).toEqual({ mode: "yolo", saved: "manual" });
	});
});
