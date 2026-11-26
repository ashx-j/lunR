import { describe, expect, it, vi } from "vitest";
import { handleExportCommand, type SessionFileCommandHost } from "../src/modes/interactive/session-files.ts";
import { SessionAutoNamer, type SessionAutoNamerHost } from "../src/modes/interactive/session-naming.ts";

describe("/export", () => {
	it("takes a quoted path with spaces and writes JSONL for a .jsonl path", async () => {
		const exportToJsonl = vi.fn((path: string) => path);
		const host = { session: { exportToJsonl }, showStatus: vi.fn(), showError: vi.fn() };
		await handleExportCommand(host as unknown as SessionFileCommandHost, '/export "my run.jsonl" extra');
		expect(exportToJsonl).toHaveBeenCalledWith("my run.jsonl");
		expect(host.showStatus).toHaveBeenCalledWith("Session exported to: my run.jsonl");
	});
});

describe("SessionAutoNamer", () => {
	function createHost(userMessages: Array<{ text: string }>) {
		const complete = vi.fn(async () => ({ content: [{ type: "text", text: '"Fix the parser."' }] }));
		const setSessionName = vi.fn();
		const host = {
			session: {
				model: { id: "m" },
				modelRuntime: { complete },
				getUserMessagesForForking: () => userMessages,
				setSessionName,
			},
			sessionManager: {
				getSessionName: () => undefined,
				getSessionId: () => "s1",
				getSessionFile: () => undefined,
				appendRequestUsage: vi.fn(),
			},
			settingsManager: { getModelTiersEnabled: () => false },
			resolveModelReference: () => undefined,
		};
		return { host: host as unknown as SessionAutoNamerHost, complete, setSessionName };
	}

	it("asks for a title once for a fresh session and strips quotes and trailing punctuation", async () => {
		const { host, complete, setSessionName } = createHost([{ text: "the parser crashes" }]);
		const namer = new SessionAutoNamer(host);
		namer.maybeAutoNameSession();
		namer.maybeAutoNameSession();
		await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith("Fix the parser"));
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("leaves a resumed session with several prompts unnamed", () => {
		const { host, complete } = createHost([{ text: "one" }, { text: "two" }]);
		new SessionAutoNamer(host).maybeAutoNameSession();
		expect(complete).not.toHaveBeenCalled();
	});
});
