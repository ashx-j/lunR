import { describe, expect, it } from "vitest";
import { FULL_SUBAGENT_TOOL_DESCRIPTION, COMPACT_SUBAGENT_TOOL_DESCRIPTION, buildSubagentToolDescription } from "../src/builtin-extensions/pi-subagents/src/extension/tool-description.ts";
import {
	advertisedDefaultContext,
	lunrChildContext,
	lunrContextPolicy,
} from "../src/builtin-extensions/pi-subagents/src/shared/lunr-child-context.ts";

describe("lunr child context is always fresh", () => {
	it("coerces omitted, fork, and fresh requests to fresh", () => {
		expect(lunrChildContext(undefined)).toBe("fresh");
		expect(lunrChildContext("fork")).toBe("fresh");
		expect(lunrChildContext("fresh")).toBe("fresh");
	});

	it("forces worker-style defaultContext fork to fresh in the policy", () => {
		const omitted = lunrContextPolicy({});
		expect(omitted.usesFork).toBe(false);
		expect(omitted.params.context).toBe("fresh");
		expect(omitted.contextForAgent("worker")).toBe("fresh");

		const explicitFork = lunrContextPolicy({ context: "fork" });
		expect(explicitFork.usesFork).toBe(false);
		expect(explicitFork.params.context).toBe("fresh");
		expect(explicitFork.contextForAgent("oracle")).toBe("fresh");
	});

	it("list/get view never advertises fork", () => {
		expect(advertisedDefaultContext("fork")).toBe("fresh");
		expect(advertisedDefaultContext("fresh")).toBe("fresh");
		expect(advertisedDefaultContext(undefined)).toBe("fresh");
	});

	it("tool description does not mention fork", () => {
		expect(FULL_SUBAGENT_TOOL_DESCRIPTION.toLowerCase()).not.toContain("fork");
		expect(COMPACT_SUBAGENT_TOOL_DESCRIPTION.toLowerCase()).not.toContain("fork");
		expect(buildSubagentToolDescription({}).toLowerCase()).not.toContain("fork");
	});
});
