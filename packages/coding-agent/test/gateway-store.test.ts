import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSession,
	listSessions,
	putSession,
	removeSession,
	setGatewayStorePath,
	touchSession,
} from "../src/gateway/store.ts";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-store-"));
	file = join(dir, "gateway-sessions.json");
	setGatewayStorePath(file);
});

afterEach(() => {
	setGatewayStorePath(undefined);
	rmSync(dir, { recursive: true, force: true });
});

describe("gateway session store", () => {
	it("starts empty when the file is missing", () => {
		expect(listSessions()).toEqual({});
		expect(getSession("nope")).toBeUndefined();
	});

	it("put/get/list round-trips and preserves createdAt", async () => {
		const stored = putSession("k1", { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
		expect(stored.sessionId).toBe("s1");
		expect(getSession("k1")?.sessionFile).toBe("/tmp/s1.jsonl");

		await new Promise((resolve) => setTimeout(resolve, 5));
		const again = putSession("k1", { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
		expect(again.createdAt).toBe(stored.createdAt);
		expect(Date.parse(again.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(stored.lastActiveAt));
		expect(Object.keys(listSessions())).toEqual(["k1"]);
	});

	it("touch updates lastActiveAt only", async () => {
		const stored = putSession("k1", { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		touchSession("k1");
		const touched = getSession("k1");
		expect(touched?.createdAt).toBe(stored.createdAt);
		expect(Date.parse(touched!.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(stored.lastActiveAt));
		touchSession("missing"); // no-op, no throw
	});

	it("remove deletes existing keys and reports misses", () => {
		putSession("k1", { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
		expect(removeSession("k1")).toBe(true);
		expect(getSession("k1")).toBeUndefined();
		expect(removeSession("k1")).toBe(false);
	});

	it("tolerates a corrupt file and starts empty", () => {
		writeFileSync(file, "not json at all", "utf-8");
		expect(listSessions()).toEqual({});
		// ...and recovers on the next write
		putSession("k1", { sessionId: "s1", sessionFile: "/tmp/s1.jsonl" });
		expect(getSession("k1")?.sessionId).toBe("s1");
	});

	it("drops malformed entries but keeps valid ones", () => {
		writeFileSync(
			file,
			JSON.stringify({
				good: {
					sessionId: "s1",
					sessionFile: "/tmp/s1.jsonl",
					createdAt: "2026-01-01",
					lastActiveAt: "2026-01-01",
				},
				bad: { nope: true },
			}),
			"utf-8",
		);
		expect(Object.keys(listSessions())).toEqual(["good"]);
	});
});
