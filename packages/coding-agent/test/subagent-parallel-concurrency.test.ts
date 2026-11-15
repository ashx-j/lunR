import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_GLOBAL_CONCURRENCY_LIMIT,
	MAX_PARALLEL_CONCURRENCY,
	mapConcurrent,
	Semaphore,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/parallel-utils.ts";
import {
	MAX_CONCURRENCY,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

describe("parallel subagent defaults", () => {
	it("does not cap default concurrency at 4", () => {
		expect(MAX_CONCURRENCY).toBeGreaterThan(4);
		expect(MAX_PARALLEL_CONCURRENCY).toBeGreaterThan(4);
		expect(DEFAULT_GLOBAL_CONCURRENCY_LIMIT).toBeGreaterThan(4);
		expect(resolveTopLevelParallelConcurrency(undefined, undefined)).toBeGreaterThan(4);
	});

	it("does not cap default task count at 8", () => {
		expect(resolveTopLevelParallelMaxTasks(undefined)).toBeGreaterThan(8);
	});

	it("honors an explicit concurrency override", () => {
		expect(resolveTopLevelParallelConcurrency(3, undefined)).toBe(3);
		expect(resolveTopLevelParallelConcurrency(undefined, 6)).toBe(6);
	});
});

afterEach(() => vi.useRealTimers());

describe("parallel launch scheduling", () => {
	it.each([
		[10, 2],
		[100, 2],
		[100, Number.MAX_SAFE_INTEGER],
	])("bounds the cold-start delay for %i jobs at concurrency %i", async (count, concurrency) => {
		vi.useFakeTimers();
		const start = Date.now();
		const launches: number[] = [];
		const work = mapConcurrent(
			Array.from({ length: count }, (_, i) => i),
			concurrency,
			async (i) => {
				launches.push(Date.now() - start);
				return i;
			},
		);
		await vi.advanceTimersByTimeAsync(1000);
		expect(launches).toHaveLength(count);
		expect(Math.max(...launches)).toBeLessThanOrEqual(1000);
		expect(await work).toEqual(Array.from({ length: count }, (_, i) => i));
	});

	it("settles queued launch and semaphore waits on abort without dispatching them", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const semaphore = new Semaphore(1);
		await semaphore.acquire();
		const launch = vi.fn(async (i: number) => i);
		const work = mapConcurrent([0, 1, 2], 3, launch, semaphore, {
			signal: controller.signal,
			onAbort: () => -1,
		});
		await vi.advanceTimersByTimeAsync(0);
		let settled = false;
		void work.then(() => {
			settled = true;
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		await expect(work).resolves.toEqual([-1, -1, -1]);
		expect(launch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		semaphore.release();
		await semaphore.acquire();
		semaphore.release();
	});

	it("retains explicit concurrency and starts unlimited siblings after the allowance", async () => {
		vi.useFakeTimers();
		let active = 0;
		let peak = 0;
		const release: Array<() => void> = [];
		const work = mapConcurrent([0, 1, 2, 3], 2, async (i) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => release.push(resolve));
			active--;
			return i;
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(release).toHaveLength(2);
		for (const resolve of release.splice(0)) resolve();
		await vi.advanceTimersByTimeAsync(0);
		expect(release).toHaveLength(2);
		for (const resolve of release) resolve();
		await work;
		expect(peak).toBe(2);
	});
});
