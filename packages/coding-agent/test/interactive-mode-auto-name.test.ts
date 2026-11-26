import { expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const maybeAutoNameSession = Reflect.get(InteractiveMode.prototype, "maybeAutoNameSession") as (this: object) => void;

/** An unnamed fresh session after its first turn. */
function createMode(isShuttingDown: boolean) {
	return {
		isShuttingDown,
		autoNameTriggered: false,
		sessionManager: { getSessionName: () => undefined },
		session: { getUserMessagesForForking: () => [{ text: "Read files" }] },
		generateSessionTitle: vi.fn(async () => {}),
	};
}

it("asks for a session title after the first turn", () => {
	const mode = createMode(false);
	maybeAutoNameSession.call(mode);
	expect(mode.generateSessionTitle).toHaveBeenCalledWith("Read files");
});

it("asks for no title when the first turn ended because lunR is shutting down", () => {
	const mode = createMode(true);
	maybeAutoNameSession.call(mode);
	expect(mode.generateSessionTitle).not.toHaveBeenCalled();
});
