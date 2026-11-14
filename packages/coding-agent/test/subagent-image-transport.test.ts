import { describe, expect, it } from "vitest";
import {
	createBoundedLineReader,
	MAX_CHILD_PENDING_LINE_BYTES,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-protocol.ts";
import { createChildEventDecoder, encodeChildEventLines } from "../src/core/subagent-event-transport.ts";

describe("child JSON event transport", () => {
	it("delivers a synthetic image event through the bounded stdout reader intact", () => {
		const event = {
			type: "tool_result_end",
			message: { content: [{ type: "image", data: "a".repeat(5 * 1024 * 1024), mimeType: "image/png" }] },
		};
		const decoded: string[] = [];
		const decode = createChildEventDecoder();
		const limits: unknown[] = [];
		const reader = createBoundedLineReader({
			onLine: (line) => {
				const result = decode(line);
				if (result !== undefined) decoded.push(result);
			},
			onLimit: (limit) => limits.push(limit),
		});
		const serialized = JSON.stringify(event);
		const oldLimits: unknown[] = [];
		createBoundedLineReader({ onLine: () => {}, onLimit: (limit) => oldLimits.push(limit) }).push(`${serialized}\n`);
		expect(oldLimits).toMatchObject([{ code: "protocol_output_limit", limitBytes: MAX_CHILD_PENDING_LINE_BYTES }]);
		const lines = [...encodeChildEventLines(serialized)];
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(Buffer.byteLength(line)).toBeLessThan(MAX_CHILD_PENDING_LINE_BYTES);
			reader.push(`${line}\n`);
		}
		expect(limits).toEqual([]);
		expect(decoded).toEqual([JSON.stringify(event)]);
	});

	it("keeps ordinary JSON lines unchanged and rejects an interrupted chunk sequence", () => {
		const decode = createChildEventDecoder();
		const ordinary = JSON.stringify({ type: "message_end", message: { content: [] } });
		expect(decode(ordinary)).toBe(ordinary);
		const chunks = [...encodeChildEventLines(JSON.stringify({ data: "a".repeat(2 * 1024 * 1024) }))];
		expect(decode(chunks[0]!)).toBeUndefined();
		expect(() => decode(ordinary)).toThrow("Incomplete child event chunks");
	});

	it("rejects events above the aggregate cap without relaxing the line guard", () => {
		expect(() => [...encodeChildEventLines(JSON.stringify({ data: "a".repeat(25 * 1024 * 1024) }))]).toThrow(
			"transport limit",
		);
	});
});
