import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONCURRENCY_LIMIT, MAX_PARALLEL_CONCURRENCY } from "../src/builtin-extensions/pi-subagents/src/runs/shared/parallel-utils.ts";
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
