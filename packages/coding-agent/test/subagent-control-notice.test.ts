import { describe, expect, it, vi } from "vitest";
import { handleSubagentControlNotice } from "../src/builtin-extensions/pi-subagents/src/extension/control-notices.ts";

describe("subagent control notices", () => {
	it("sends needs-attention with display false and without triggering a parent turn", () => {
		const sendMessage = vi.fn();
		handleSubagentControlNotice({
			pi: { sendMessage },
			state: {
				pendingForegroundControlNotices: new Map(),
				foregroundControls: new Map(),
			},
			visibleControlNotices: new Set(),
			details: {
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: Date.now(),
					agent: "researcher",
					runId: "run-1",
					message: "Subagent needs attention: researcher",
				},
				source: "async",
			},
		});

		expect(sendMessage).toHaveBeenCalledOnce();
		const [message, options] = sendMessage.mock.calls[0]!;
		expect(message.display).toBe(false);
		expect(message.content).toContain("researcher");
		expect(options).toEqual({ triggerTurn: false });
	});
});
