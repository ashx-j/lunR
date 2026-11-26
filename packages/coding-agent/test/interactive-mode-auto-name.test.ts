import { expect, it, vi } from "vitest";
import { SessionAutoNamer, type SessionAutoNamerHost } from "../src/modes/interactive/session-naming.ts";

/** An unnamed fresh session after its first turn, with the title request recorded instead of sent. */
function createNamer(isShuttingDown: boolean) {
	const host = {
		isShuttingDown,
		sessionManager: { getSessionName: () => undefined },
		session: { getUserMessagesForForking: () => [{ text: "Read files" }] },
	};
	const namer = new SessionAutoNamer(host as unknown as SessionAutoNamerHost);
	const generateSessionTitle = vi.fn(async () => {});
	Object.assign(namer, { generateSessionTitle });
	return { namer, generateSessionTitle };
}

it("asks for a session title after the first turn", () => {
	const { namer, generateSessionTitle } = createNamer(false);
	namer.maybeAutoNameSession();
	expect(generateSessionTitle).toHaveBeenCalledWith("Read files");
});

it("asks for no title when the first turn ended because lunR is shutting down", () => {
	const { namer, generateSessionTitle } = createNamer(true);
	namer.maybeAutoNameSession();
	expect(generateSessionTitle).not.toHaveBeenCalled();
});
