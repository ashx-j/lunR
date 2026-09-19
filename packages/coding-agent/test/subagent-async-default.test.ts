import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSubagentCall } from "../src/builtin-extensions/pi-subagents/src/extension/index.ts";
import { SubagentParams } from "../src/builtin-extensions/pi-subagents/src/extension/schemas.ts";
import {
	buildSubagentToolDescription,
	COMPACT_SUBAGENT_TOOL_DESCRIPTION,
	FULL_SUBAGENT_TOOL_DESCRIPTION,
} from "../src/builtin-extensions/pi-subagents/src/extension/tool-description.ts";
import { formatAsyncStartedMessage } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
	isAsyncSubagentExecution,
	normalizeAsyncLaunchConfig,
	subagentLaunchRunsAsync,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/top-level-async.ts";
import { resolveSubagentRequestParams } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/request-params.ts";
import { SUBAGENT_ASYNC_GUIDANCE } from "../src/builtin-extensions/pi-subagents/src/shared/async-guidance.ts";
import {
	toLegacyExecutionParams,
	toSubagentDelegationExecutionParams,
} from "../src/builtin-extensions/pi-subagents/src/slash/delegation-adapters.ts";
import { parseRuntimeOptions } from "../src/builtin-extensions/pi-subagents/src/slash/prompt-workflows.ts";
import { extractExecutionFlags } from "../src/builtin-extensions/pi-subagents/src/slash/slash-commands.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const modes = [
	{ name: "single", params: { task: "Inspect auth", description: "Inspect auth", tier: "light" } },
	{ name: "parallel", params: { tasks: [{ task: "Inspect auth", description: "Inspect auth", tier: "light" }] } },
	{ name: "chain", params: { chain: [{ task: "Inspect auth", description: "Inspect auth", tier: "light" }] } },
] as const;

describe("subagent async launch resolution", () => {
	it.each(modes)("defaults omitted $name launches to async", ({ params }) => {
		expect(subagentLaunchRunsAsync(params)).toBe(true);
		expect(isAsyncSubagentExecution(params)).toBe(true);
	});

	it.each(modes)("keeps explicit async:false $name launches foreground", ({ params }) => {
		const foreground = { ...params, async: false };
		expect(subagentLaunchRunsAsync(foreground)).toBe(false);
		expect(isAsyncSubagentExecution(foreground)).toBe(false);
	});

	it("keeps clarify and internal foreground-only workflows foreground", () => {
		expect(subagentLaunchRunsAsync({ task: "Preview", clarify: true })).toBe(false);
		expect(subagentLaunchRunsAsync({ task: "Preview", async: true, clarify: true })).toBe(false);
		expect(subagentLaunchRunsAsync({ task: "Bridge", foregroundOnly: true })).toBe(false);
	});

	it("normalizes legacy config without defeating omission or explicit foreground", () => {
		expect(normalizeAsyncLaunchConfig({ asyncByDefault: false })).toMatchObject({
			asyncByDefault: true,
			forceTopLevelAsync: false,
		});
		expect(normalizeAsyncLaunchConfig({ forceTopLevelAsync: true })).toMatchObject({
			asyncByDefault: true,
			forceTopLevelAsync: false,
		});
		expect(subagentLaunchRunsAsync({ task: "Default" })).toBe(true);
		expect(subagentLaunchRunsAsync({ task: "Foreground", async: false })).toBe(false);
		expect(subagentLaunchRunsAsync({ task: "Preview", clarify: true })).toBe(false);
	});

	it("classifies normalized executable calls for async launch registration", () => {
		expect(isAsyncSubagentExecution({ action: "status" })).toBe(false);
		expect(isAsyncSubagentExecution(resolveSubagentRequestParams({ action: "resume", task: "Continue" }))).toBe(
			false,
		);
		expect(isAsyncSubagentExecution({})).toBe(false);
		expect(isAsyncSubagentExecution({ task: "Inspect" })).toBe(true);
		expect(isAsyncSubagentExecution({ tasks: [{}] })).toBe(true);
		expect(isAsyncSubagentExecution({ chain: [{}] })).toBe(true);
		expect(isAsyncSubagentExecution({ task: "Inspect", async: false })).toBe(false);

		const mixed = resolveSubagentRequestParams({
			action: "status",
			task: "Inspect",
			description: "Inspect auth",
			tier: "light",
			tasks: [{}],
			chain: [{}],
		});
		expect(mixed.action).toBeUndefined();
		expect(isAsyncSubagentExecution(mixed)).toBe(true);
	});
});

describe("subagent async discovery and recovery guidance", () => {
	it("uses one canonical concise guidance fragment in full, compact, custom, and launch results", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-async-guidance-"));
		fs.writeFileSync(path.join(root, "subagent-tool-description.md"), "Custom delegation guidance.\n");
		const custom = buildSubagentToolDescription({ toolDescriptionMode: "custom" }, { cwd: root, agentDir: root });
		fs.rmSync(root, { recursive: true, force: true });
		for (const text of [FULL_SUBAGENT_TOOL_DESCRIPTION, COMPACT_SUBAGENT_TOOL_DESCRIPTION, custom]) {
			expect(text).toContain(SUBAGENT_ASYNC_GUIDANCE);
			expect(text.split(SUBAGENT_ASYNC_GUIDANCE)).toHaveLength(2);
		}
		const result = formatAsyncStartedMessage("Async: Inspect auth [run-id]");
		expect(result).toContain(SUBAGENT_ASYNC_GUIDANCE);
		expect(result).toContain('subagent({ action: "status", id: "..." })');
		expect(result).not.toContain("polling loops");
	});

	it("describes omission, explicit foreground, and clarify in the schema", () => {
		const properties = (SubagentParams as { properties: Record<string, { description?: string }> }).properties;
		expect(properties.async.description).toContain("Defaults to true when omitted");
		expect(properties.async.description).toContain("set false");
		expect(properties.clarify.description).toContain("keeps the run foreground");
	});

	it.each(modes)("shows the resolved async header for omitted $name launches", ({ params }) => {
		const text = renderSubagentCall(params, theme, {}).render(100).join("\n");
		expect(text).toContain("subagent async");
	});

	it("renders mixed launch payloads by their normalized async dispatch mode", () => {
		const text = renderSubagentCall(
			{
				action: "status",
				task: "Inspect auth",
				description: "Inspect auth",
				tier: "light",
				tasks: [{}],
				chain: [{}],
			},
			theme,
			{},
		)
			.render(100)
			.join("\n");
		expect(text).toContain("subagent async Inspect auth");
		expect(text).not.toContain("status");
	});

	it("omits the async header for explicit foreground and clarify launches", () => {
		expect(renderSubagentCall({ task: "Inspect", async: false }, theme, {}).render(100).join("\n")).not.toContain(
			"async",
		);
		expect(renderSubagentCall({ task: "Inspect", clarify: true }, theme, {}).render(100).join("\n")).not.toContain(
			"async",
		);
	});
});

describe("slash and protocol launch modes", () => {
	it("defaults direct slash and prompt workflows to async with explicit foreground flags", () => {
		expect(extractExecutionFlags("Inspect[tier=light] task")).toEqual({
			args: "Inspect[tier=light] task",
			async: undefined,
		});
		expect(extractExecutionFlags("Inspect[tier=light] task --foreground")).toEqual({
			args: "Inspect[tier=light] task",
			async: false,
		});
		expect(extractExecutionFlags("Inspect[tier=light] task --bg")).toEqual({
			args: "Inspect[tier=light] task",
			async: true,
		});
		expect(parseRuntimeOptions(["input"])).toMatchObject({ args: ["input"], async: undefined });
		expect(parseRuntimeOptions(["--foreground", "input"])).toMatchObject({ args: ["input"], async: false });
		expect(parseRuntimeOptions(["--async", "input"])).toMatchObject({ args: ["input"], async: true });
	});

	it("keeps correlated delegation bridges foreground", () => {
		const legacy = toLegacyExecutionParams({
			requestId: "legacy",
			agent: "Inspect auth",
			task: "Inspect auth",
			tier: "light",
			context: "fresh",
			cwd: process.cwd(),
		});
		expect(legacy).toMatchObject({ async: false, foregroundOnly: true, clarify: false });

		const delegated = toSubagentDelegationExecutionParams({
			version: 2,
			requestId: "delegated",
			agent: "Inspect auth",
			task: "Inspect auth",
			tier: "light",
			context: "fresh",
			cwd: process.cwd(),
		});
		expect(delegated).toMatchObject({ async: false, foregroundOnly: true, clarify: false });
	});
});
