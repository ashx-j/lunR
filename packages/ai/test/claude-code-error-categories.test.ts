import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("retains safe recovery categories through the Python worker with fake native failures", () => {
	const fixture = fileURLToPath(new URL("./fixtures/claude_error_categories.py", import.meta.url));
	const bridge = fileURLToPath(
		new URL("../vendor/hermes-claude-subscription-directsdk/lunr_bridge.py", import.meta.url),
	);
	const result = spawnSync("python3", ["-B", fixture, bridge], { encoding: "utf8" });
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual([
		"context_overflow",
		"context_overflow",
		"timeout",
		"rate_limit",
		"overloaded",
		"transient",
		"incomplete",
		"incomplete",
		"setup",
		"setup",
	]);
});
