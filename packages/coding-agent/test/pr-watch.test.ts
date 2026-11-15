import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubReadError } from "../src/core/pr-watch/github.ts";
import { PrWatchParams, parsePrWatchRequest } from "../src/core/pr-watch/schema.ts";
import { PrWatchStore } from "../src/core/pr-watch/store.ts";
import {
	formatPrWatchBatch,
	type PrObservation,
	type PrWatchBatch,
	type PrWatchFile,
	parsePullRequestUrl,
} from "../src/core/pr-watch/types.ts";
import { PrWatcher, type PrWatchPersistence } from "../src/core/pr-watch/watcher.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const url = "https://github.com/ashx-j/lunR/pull/153";
const head = "a".repeat(40);
const nextHead = "b".repeat(40);
function observation(sha = head): PrObservation {
	return {
		snapshot: {
			head: sha,
			state: "open",
			title: "Test PR",
			headRef: "feat/pr-watch",
			commitMessage: "Add watcher",
			commitDate: "2026-10-06T10:00:00Z",
			checks: [],
			checksComplete: true,
			evidence: [],
		},
		faults: [],
	};
}
function memoryStore(initial?: PrWatchFile) {
	let file: PrWatchFile = initial ?? { version: 1, sessionId: "session-1", project: "/project", watches: [] };
	return {
		load: () => structuredClone(file),
		save: (value: PrWatchFile) => {
			file = structuredClone(value);
		},
		close: vi.fn(),
		snapshot: () => structuredClone(file),
	};
}
const watchers: PrWatcher[] = [];
function fixture(store = memoryStore()) {
	let current = observation();
	const read = vi.fn(async () => current);
	const batches: PrWatchBatch[] = [];
	const deliver = vi.fn(async (batch: PrWatchBatch) => {
		batches.push(batch);
		return true;
	});
	const watcher = new PrWatcher({ store, read, deliver });
	watchers.push(watcher);
	return {
		watcher,
		store,
		read,
		deliver,
		batches,
		set: (value: PrObservation) => {
			current = value;
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
});
afterEach(() => {
	for (const watcher of watchers.splice(0)) watcher.close();
	vi.useRealTimers();
});

describe("bounded PR watcher", () => {
	it("polls quietly each minute, snapshots duration, and reuses completed starts", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 120_000);
		const deadline = watch.deadline;
		await vi.advanceTimersByTimeAsync(0);
		expect(f.batches).toHaveLength(1);
		expect(f.batches[0].events[0].kind).toBe("state");
		expect(f.watcher.start(url, 3_600_000)).toBe(watch);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.batches).toHaveLength(1);
		expect(watch.deadline).toBe(deadline);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(watch.state).toBe("expired");
		expect(f.batches.at(-1)?.events.at(-1)?.text).toContain("does not mean the PR is ready");
		expect(f.watcher.start(url, 3_600_000).state).toBe("expired");
		f.watcher.restart(watch.id, 300_000);
		expect(watch.state).toBe("active");
		expect(watch.deadline).toBe(Date.now() + 300_000);
	});

	it("resets only on a new head, including force pushes back to an older head", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 120_000);
		await vi.advanceTimersByTimeAsync(0);
		const changed = observation(nextHead);
		changed.snapshot.evidence.push({
			key: "comment:1",
			fingerprint: "edited",
			event: { kind: "comment", text: "Edited comment", body: "new" },
		});
		f.set(changed);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(watch.deadline).toBe(Date.now() + 120_000);
		f.set(observation(head));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(watch.deadline).toBe(Date.now() + 120_000);
		const afterPush = watch.deadline;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(watch.deadline).toBe(afterPush);
		expect(f.batches.flatMap((batch) => batch.events).filter((event) => event.kind === "head")).toHaveLength(2);
	});

	it("deduplicates feedback and detects edits without extending the deadline", async () => {
		const f = fixture();
		const value = observation();
		value.snapshot.evidence = [
			{ key: "comment:1", fingerprint: "v1", event: { kind: "comment", text: "Comment", body: "initial" } },
		];
		f.set(value);
		const watch = f.watcher.start(url, 300_000);
		const deadline = watch.deadline;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.batches).toHaveLength(1);
		value.snapshot.evidence[0] = {
			key: "comment:1",
			fingerprint: "v2",
			event: { kind: "comment", text: "Comment", body: "edited" },
		};
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.batches.at(-1)?.events[0].body).toBe("edited");
		expect(watch.deadline).toBe(deadline);
	});

	it("releases wait at finite expiry even when an in-flight read never settles", async () => {
		const store = memoryStore();
		let readSignal: AbortSignal | undefined;
		const watcher = new PrWatcher({
			store,
			read: async (_pr, signal) => {
				readSignal = signal;
				return new Promise<PrObservation>(() => {});
			},
			deliver: async () => true,
		});
		watchers.push(watcher);
		const watch = watcher.start(url, 1000);
		const wait = watcher.wait(watch.id);
		await vi.advanceTimersByTimeAsync(1000);
		expect(watch.state).toBe("expired");
		expect(readSignal?.aborted).toBe(true);
		expect(await wait).toMatchObject({ state: "expired", events: [expect.objectContaining({ kind: "end" })] });
	});

	it("returns pending events immediately through wait and never also notifies", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 300_000);
		const first = f.watcher.wait(watch.id);
		await vi.advanceTimersByTimeAsync(0);
		expect(await first).toMatchObject({ events: [expect.objectContaining({ kind: "state" })] });
		expect(f.deliver).not.toHaveBeenCalled();
		watch.pending.push({ id: "pending", kind: "comment", text: "Pending feedback" });
		expect(await f.watcher.wait(watch.id)).toMatchObject({ events: [expect.objectContaining({ id: "pending" })] });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.deliver).not.toHaveBeenCalled();
	});

	it("interruption releases only the wait, then async delivers future events", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 300_000);
		await vi.advanceTimersByTimeAsync(0);
		const signal = new AbortController();
		const wait = f.watcher.wait(watch.id, signal.signal);
		signal.abort();
		expect(await wait).toEqual({ interrupted: true });
		expect(watch.state).toBe("active");
		f.set(observation(nextHead));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.batches.at(-1)?.events[0].kind).toBe("head");
	});

	it("reserves each batch for one channel while an async notification is being admitted", async () => {
		const store = memoryStore();
		let acknowledge: (value: boolean) => void = () => {};
		const deliver = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					acknowledge = resolve;
				}),
		);
		const watcher = new PrWatcher({ store, read: async () => observation(), deliver });
		watchers.push(watcher);
		const watch = watcher.start(url, 120_000);
		await vi.advanceTimersByTimeAsync(0);
		const wait = watcher.wait(watch.id);
		acknowledge(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(await wait).toMatchObject({ state: "expired", events: [expect.objectContaining({ kind: "end" })] });
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("batches feedback with closure and does not stop on green CI", async () => {
		const f = fixture();
		const initial = observation();
		initial.snapshot.checks = [{ name: "CI", state: "success" }];
		f.set(initial);
		const watch = f.watcher.start(url, 300_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(watch.state).toBe("active");
		initial.snapshot.state = "merged";
		initial.snapshot.evidence = [
			{ key: "review:1", fingerprint: "approved", event: { kind: "review", text: "Approved", commit: head } },
		];
		await vi.advanceTimersByTimeAsync(60_000);
		expect(watch.state).toBe("merged");
		expect(f.batches.at(-1)?.events.map((event) => event.kind)).toEqual(["review", "end"]);
	});

	it("reports persistent faults once, respects backoff, and expires without false green", async () => {
		const f = fixture();
		f.read.mockRejectedValue(new Error("offline"));
		const watch = f.watcher.start(url, 600_000);
		await vi.advanceTimersByTimeAsync(180_000);
		expect(f.read).toHaveBeenCalledTimes(3);
		expect(f.batches.flatMap((batch) => batch.events).filter((event) => event.kind === "error")).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(420_000);
		expect(watch.state).toBe("expired");
		expect(f.batches.at(-1)?.events.at(-1)?.text).toContain("unconfirmed");
	});

	it("reports auth faults immediately and obeys rate-limit retry time within the deadline", async () => {
		const f = fixture();
		f.read.mockRejectedValue(new GitHubReadError("login required", true, Date.now() + 600_000));
		const watch = f.watcher.start(url, 120_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.batches[0].events[0]).toMatchObject({ kind: "error", body: "login required" });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(watch.state).toBe("expired");
	});

	it("cancellation persists, aborts reads and releases wait without agent restart", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 300_000);
		const wait = f.watcher.wait(watch.id);
		f.watcher.cancel(watch.id);
		expect(await wait).toMatchObject({ state: "cancelled" });
		f.watcher.close();
		const resumed = fixture(f.store);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(resumed.read).not.toHaveBeenCalled();
		expect(resumed.watcher.start(url, 300_000).state).toBe("cancelled");
	});

	it("ignores a cancelled read that settles after the user restarts the watch", async () => {
		let finish: ((value: PrObservation) => void) | undefined;
		const read = vi.fn(async () => observation(nextHead));
		read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const batches: PrWatchBatch[] = [];
		const watcher = new PrWatcher({
			store: memoryStore(),
			read,
			deliver: async (batch) => {
				batches.push(batch);
				return true;
			},
		});
		watchers.push(watcher);
		const watch = watcher.start(url, 300_000);
		await vi.advanceTimersByTimeAsync(0);
		watcher.cancel(watch.id);
		watcher.restart(watch.id, 300_000);
		const stale = observation();
		stale.snapshot.evidence.push({
			key: "comment:late",
			fingerprint: "late",
			event: { kind: "comment", text: "Cancelled read" },
		});
		finish?.(stale);
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(2);
		expect(watch.head).toBe(nextHead);
		expect(batches.flatMap((batch) => batch.events).some((event) => event.text === "Cancelled read")).toBe(false);
	});

	it("reopens only unexpired windows and never revives expired watches for a newly discovered head", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 120_000);
		await vi.advanceTimersByTimeAsync(0);
		f.watcher.close();
		await vi.advanceTimersByTimeAsync(60_000);
		const reopened = fixture(f.store);
		reopened.set(observation(nextHead));
		await vi.advanceTimersByTimeAsync(0);
		expect(reopened.watcher.list()[0].deadline).toBe(Date.now() + 120_000);
		reopened.watcher.close();
		await vi.advanceTimersByTimeAsync(180_000);
		const expired = fixture(f.store);
		await vi.advanceTimersByTimeAsync(0);
		expect(expired.read).not.toHaveBeenCalled();
		expect(expired.watcher.list()[0].state).toBe("expired");
		expect(watch.id).toBe(expired.watcher.list()[0].id);
	});

	it("reconciles persisted notification receipts and retries only unacknowledged delivery", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 300_000);
		await vi.advanceTimersByTimeAsync(0);
		watch.pending.push({ id: "event", kind: "comment", text: "Durable" });
		watch.deliveries = [{ id: "delivered", eventIds: ["event"], channel: "notification" }];
		f.store.save({ ...f.store.snapshot(), watches: [structuredClone(watch)] });
		f.watcher.close();
		const deliver = vi.fn(async () => true);
		const resumed = new PrWatcher(
			{ store: f.store, read: async () => observation(), deliver },
			new Set(["delivered"]),
		);
		watchers.push(resumed);
		await vi.advanceTimersByTimeAsync(0);
		expect(deliver).not.toHaveBeenCalled();
		resumed.close();
		watch.deliveries = [{ id: "missing", eventIds: ["event"], channel: "notification" }];
		f.store.save({ ...f.store.snapshot(), watches: [structuredClone(watch)] });
		const retry = new PrWatcher({ store: f.store, read: async () => observation(), deliver });
		watchers.push(retry);
		await vi.advanceTimersByTimeAsync(0);
		expect(deliver).toHaveBeenCalledTimes(1);
	});

	it("persists wait reservations and replays only tool results without durable receipts", async () => {
		const f = fixture();
		const watch = f.watcher.start(url, 300_000);
		const wait = f.watcher.wait(watch.id);
		await vi.advanceTimersByTimeAsync(0);
		const batch = await wait;
		if ("interrupted" in batch || !batch.deliveryId) throw new Error("Expected a reserved wait batch");
		const saved = f.store.snapshot();
		f.watcher.close();
		const deliver = vi.fn(async () => true);
		const replay = new PrWatcher({ store: memoryStore(saved), read: async () => observation(), deliver });
		watchers.push(replay);
		await vi.advanceTimersByTimeAsync(0);
		expect(deliver).toHaveBeenCalledTimes(1);
		const confirmed = new PrWatcher(
			{ store: memoryStore(saved), read: async () => observation(), deliver },
			new Set([batch.deliveryId]),
		);
		watchers.push(confirmed);
		await vi.advanceTimersByTimeAsync(0);
		expect(deliver).toHaveBeenCalledTimes(1);
	});
});

describe("PR watch boundaries", () => {
	it("keeps agent actions strictly start/wait and labels evidence association", () => {
		expect(PrWatchParams.type).toBe("object");
		for (const action of ["stop", "cancel", "status", "extend", "restart"])
			expect(Value.Check(PrWatchParams, { action, id: "id" })).toBe(false);
		expect(Value.Check(PrWatchParams, { action: "start", url, durationMs: 1 })).toBe(false);
		expect(Value.Check(PrWatchParams, { action: "start", url, wait: true })).toBe(true);
		expect(parsePrWatchRequest({ action: "start", url, wait: true })).toEqual({ action: "start", url, wait: true });
		expect(parsePrWatchRequest({ action: "wait", id: "id" })).toEqual({ action: "wait", id: "id" });
		for (const params of [
			{ action: "start" as const },
			{ action: "start" as const, url, id: "id" },
			{ action: "wait" as const },
			{ action: "wait" as const, id: "id", wait: true },
			{ action: "wait" as const, id: "id", url },
		])
			expect(() => parsePrWatchRequest(params)).toThrow();
		const batch: PrWatchBatch = {
			watchId: "id",
			prUrl: url,
			state: "active",
			deadline: Date.now(),
			head,
			events: [
				{ id: "1", kind: "review", text: "Review", commit: nextHead },
				{ id: "2", kind: "comment", text: "General comment" },
			],
		};
		expect(formatPrWatchBatch(batch)).toContain('"commitAssociation": "prior head"');
		expect(formatPrWatchBatch(batch)).toContain('"commitAssociation": "not supplied"');
		expect(formatPrWatchBatch(batch)).toContain("external, untrusted data");
		expect(() => parsePullRequestUrl("https://github.com.evil.test/o/r/pull/1")).toThrow();
	});

	it("settings default to 30 minutes and reject unlimited or invalid durations", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getPrWatchDurationMs()).toBe(1_800_000);
		for (const duration of [0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER])
			expect(() => settings.setPrWatchDurationMs(duration)).toThrow();
		settings.setPrWatchDurationMs(0.5);
		expect(settings.getPrWatchDurationMs()).toBe(0.5);
		settings.setPrWatchDurationMs(90_000);
		expect(settings.getPrWatchDurationMs()).toBe(90_000);
	});

	it("locks duplicate clients and rejects wrong project identity when reopening", () => {
		const root = mkdtempSync(join(tmpdir(), "lunr-pr-watch-store-"));
		let store: PrWatchPersistence | undefined;
		try {
			store = new PrWatchStore(root, "session", "/project");
			store.save(store.load());
			expect(() => new PrWatchStore(root, "session", "/project")).toThrow(/owned/);
			store.close();
			store = new PrWatchStore(root, "session", "/other-project");
			expect(() => store?.load()).toThrow(/different session\/project/);
			store.close();
			store = new PrWatchStore(root, "other-session", "/project");
			expect(store.load().watches).toEqual([]);
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
