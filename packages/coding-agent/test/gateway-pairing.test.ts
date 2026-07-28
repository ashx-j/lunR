import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPairingStore } from "../src/gateway/pairing.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lunr-gw-pairing-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function makeStore(now: { t: number }) {
	return createPairingStore({ dir, now: () => now.t });
}

describe("pairing", () => {
	it("issues 8-char codes from the unambiguous alphabet (no 0/O/1/I/L)", () => {
		const store = createPairingStore({ dir, now: () => 1000, maxPending: 30 });
		for (let i = 0; i < 20; i++) {
			const code = store.issueCode("telegram", `user-${i}`);
			expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
		}
	});

	it("approve round-trips: issue → approve → isPaired", () => {
		const store = makeStore({ t: 1000 });
		const code = store.issueCode("telegram", "u1")!;
		expect(store.isPaired("telegram", "u1")).toBe(false);
		expect(store.approve("telegram", code)).toBe("u1");
		expect(store.isPaired("telegram", "u1")).toBe(true);
		// Code is single-use.
		expect(store.approve("telegram", code)).toBe(null);
	});

	it("approve accepts dashed/lowercased code formatting", () => {
		const store = makeStore({ t: 1000 });
		const code = store.issueCode("telegram", "u1")!;
		const dashed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
		expect(store.approve("telegram", dashed)).toBe("u1");
	});

	it("expires codes after the TTL", () => {
		const now = { t: 1000 };
		const store = createPairingStore({ dir, ttlMs: 60_000, now: () => now.t });
		const code = store.issueCode("telegram", "u1")!;
		now.t += 61_000;
		expect(store.approve("telegram", code)).toBe(null);
		expect(store.listPending()).toEqual([]);
	});

	it("rate-limits re-issue per user", () => {
		const now = { t: 1000 };
		const store = createPairingStore({ dir, rateLimitMs: 10_000, now: () => now.t });
		expect(store.issueCode("telegram", "u1")).not.toBe(null);
		expect(store.issueCode("telegram", "u1")).toBe(null);
		now.t += 10_001;
		expect(store.issueCode("telegram", "u1")).not.toBe(null);
	});

	it("caps pending codes per platform (max 3 default)", () => {
		const store = makeStore({ t: 1000 });
		expect(store.issueCode("telegram", "u1")).not.toBe(null);
		expect(store.issueCode("telegram", "u2")).not.toBe(null);
		expect(store.issueCode("telegram", "u3")).not.toBe(null);
		expect(store.issueCode("telegram", "u4")).toBe(null);
		// The cap is per-platform.
		expect(store.issueCode("discord", "u4")).not.toBe(null);
	});

	it("invalidates a pending code after 5 failed approve attempts (lockout)", () => {
		const store = createPairingStore({ dir, maxFails: 5, now: () => 1000 });
		const code = store.issueCode("telegram", "u1")!;
		for (let i = 0; i < 4; i++) {
			expect(store.approve("telegram", "WRONGCODE")).toBe(null);
		}
		// 4 fails: still valid.
		expect(store.approve("telegram", code)).toBe("u1");
	});

	it("5 fails lock the code out", () => {
		const store = createPairingStore({ dir, maxFails: 5, now: () => 1000 });
		const code = store.issueCode("telegram", "u1")!;
		for (let i = 0; i < 5; i++) {
			expect(store.approve("telegram", "WRONGCODE")).toBe(null);
		}
		expect(store.approve("telegram", code)).toBe(null);
		expect(store.listPending()).toEqual([]);
	});

	it("listPending and listApproved reflect state", () => {
		const store = makeStore({ t: 1000 });
		const code = store.issueCode("telegram", "u1")!;
		expect(store.listPending()).toEqual([{ code, platform: "telegram", userId: "u1", expiresAt: 1000 + 3_600_000 }]);
		store.approve("telegram", code);
		expect(store.listPending()).toEqual([]);
		expect(store.listApproved()).toEqual([{ platform: "telegram", userId: "u1", approvedAt: 1000 }]);
	});

	it("persists across store instances (same dir)", () => {
		const now = { t: 1000 };
		const code = makeStore(now).issueCode("telegram", "u1")!;
		expect(makeStore(now).approve("telegram", code)).toBe("u1");
		expect(makeStore(now).isPaired("telegram", "u1")).toBe(true);
	});
});
