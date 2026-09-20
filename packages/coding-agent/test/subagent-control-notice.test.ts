import { describe, expect, it, vi } from "vitest";
import { handleSubagentControlNotice } from "../src/builtin-extensions/pi-subagents/src/extension/control-notices.ts";

describe("subagent control notices", () => {
	it.each([undefined, "tool_failures"])(
		"keeps actionable or legacy needs-attention in model context, reason=%s",
		(reason) => {
			const sendMessage = vi.fn();
			handleSubagentControlNotice({
				pi: { sendMessage, appendEntry: vi.fn() },
				state: {
					pendingForegroundControlNotices: new Map(),
					foregroundControls: new Map(),
				},
				visibleControlNotices: new Set(),
				details: {
					event: {
						type: "needs_attention",
						reason,
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
		},
	);

	it.each(["idle", "time_threshold", "turn_threshold", "token_threshold", "completion_guard"])(
		"records %s diagnostics without a model message",
		(reason) => {
			const pi = { sendMessage: vi.fn(), appendEntry: vi.fn() };
			const input = {
				pi,
				state: { pendingForegroundControlNotices: new Map(), foregroundControls: new Map() },
				visibleControlNotices: new Set<string>(),
				details: {
					source: "async",
					event: {
						type: "needs_attention",
						to: "needs_attention",
						reason,
						ts: Date.now(),
						agent: "Inspect lock",
						runId: "run",
						message: "Diagnostic",
					},
				},
			};
			handleSubagentControlNotice(input);
			handleSubagentControlNotice(input);
			expect(pi.sendMessage).not.toHaveBeenCalled();
			expect(pi.appendEntry).toHaveBeenCalledOnce();
			expect(pi.appendEntry).toHaveBeenCalledWith(
				"subagent_control_notice",
				expect.objectContaining({ event: input.details.event }),
			);
		},
	);
});
