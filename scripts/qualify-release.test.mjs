import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheFailure } from "./qualify-release.mjs";

const rows = (pairs) => pairs.map(([cacheRead, cacheWrite]) => ({ input: 4, cacheRead, cacheWrite }));

// Live 4-request turns: master in the 2026-11-14 review (S1), then PR #263 before and after its fix.
test("cacheFailure fails flat cache reads and passes growing ones", () => {
	assert.match(cacheFailure(rows([[25352, 651], [25352, 714], [25352, 777], [25352, 840]])), /history is not read from the prompt cache/);
	assert.equal(cacheFailure(rows([[27263, 123], [27386, 65], [27451, 63], [27514, 63]])), undefined);
});

test("cacheFailure fails a turn that re-writes the history after a cold first request", () => {
	assert.match(cacheFailure(rows([[0, 28136], [27263, 936], [27263, 999], [27263, 1062]])), /re-written every request/);
});
