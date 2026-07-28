import { describe, expect, it } from "vitest";
import { applySilenceFilter, StreamConsumer } from "../src/gateway/stream.ts";

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

function makeConsumer(
	now: { t: number },
	overrides: { intervalMs?: number; threshold?: number; maxPreview?: number } = {},
) {
	const sent: string[] = [];
	const edits: Array<{ messageId: string; text: string }> = [];
	const consumer = new StreamConsumer({
		sendInitial: async (text) => {
			sent.push(text);
			return "m1";
		},
		edit: async (messageId, text) => {
			edits.push({ messageId, text });
		},
		intervalMs: overrides.intervalMs ?? 800,
		threshold: overrides.threshold ?? 24,
		maxPreview: overrides.maxPreview,
		now: () => now.t,
	});
	return { consumer, sent, edits };
}

describe("StreamConsumer", () => {
	it("does not flush below the threshold", async () => {
		const { consumer, sent } = makeConsumer({ t: 10_000 });
		consumer.push("tiny");
		await tick();
		expect(sent).toEqual([]);
	});

	it("sends the initial message once threshold and interval pass", async () => {
		const { consumer, sent } = makeConsumer({ t: 10_000 });
		consumer.push("tiny");
		consumer.push("x".repeat(30));
		await tick();
		expect(sent).toEqual([`tiny${"x".repeat(30)}`]);
	});

	it("rate-limits edits by interval", async () => {
		const now = { t: 10_000 };
		const { consumer, sent, edits } = makeConsumer(now);
		consumer.push("a".repeat(30));
		await tick();
		expect(sent).toHaveLength(1);
		// Same instant: interval gate blocks the edit.
		consumer.push("b".repeat(30));
		await tick();
		expect(edits).toEqual([]);
		// After the interval: edit lands.
		now.t += 800;
		consumer.push("c".repeat(30));
		await tick();
		expect(edits).toHaveLength(1);
		expect(edits[0].messageId).toBe("m1");
		expect(edits[0].text).toBe(`${"a".repeat(30)}${"b".repeat(30)}${"c".repeat(30)}`);
	});

	it("finalize forces a flush of everything and returns the full text", async () => {
		const { consumer, sent } = makeConsumer({ t: 10_000 });
		consumer.push("small");
		const full = await consumer.finalize();
		expect(full).toBe("small");
		expect(sent).toEqual(["small"]);
	});

	it("truncates the streaming preview to maxPreview-3 + ellipsis but returns full text", async () => {
		const { consumer, sent } = makeConsumer({ t: 10_000 }, { maxPreview: 20 });
		const text = "y".repeat(100);
		consumer.push(text);
		const full = await consumer.finalize();
		expect(full).toBe(text);
		expect(sent).toHaveLength(1);
		// maxPreview-3 chars + the ellipsis
		expect(sent[0].length).toBe(18);
		expect(sent[0].endsWith("…")).toBe(true);
	});
});

describe("applySilenceFilter", () => {
	it("returns null for whole-text markers", () => {
		expect(applySilenceFilter("[SILENT]")).toBe(null);
		expect(applySilenceFilter("NO_REPLY")).toBe(null);
		expect(applySilenceFilter("  [SILENT]  \n")).toBe(null);
	});

	it("returns null for empty text", () => {
		expect(applySilenceFilter("")).toBe(null);
		expect(applySilenceFilter("   \n ")).toBe(null);
	});

	it("strips a leading or trailing marker line", () => {
		expect(applySilenceFilter("[SILENT]\nreal answer")).toBe("real answer");
		expect(applySilenceFilter("real answer\n\nNO_REPLY")).toBe("real answer");
	});

	it("keeps markers in the middle of the text", () => {
		expect(applySilenceFilter("a [SILENT] b")).toBe("a [SILENT] b");
		expect(applySilenceFilter("one\n[SILENT]\ntwo")).toBe("one\n[SILENT]\ntwo");
	});
});
