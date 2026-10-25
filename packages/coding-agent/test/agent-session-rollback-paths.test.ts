import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./test-harness.ts";

const snapshotted = vi.hoisted(() => [] as string[]);

vi.mock("../src/core/rollback.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/rollback.ts")>()),
	rollbackSnapshotBeforeWrite: (path: string) => {
		snapshotted.push(path);
	},
}));

describe("AgentSession rollback snapshot paths", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		snapshotted.length = 0;
	});

	it("resolves edit paths the way the edit tool does", async () => {
		const editTool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Fake edit",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		harness = await createHarness({
			responses: [
				{
					toolCalls: [
						{ name: "edit", args: { path: "@src/a.ts" } },
						{ name: "edit", args: { path: "~/notes.md" } },
					],
				},
				"done",
			],
			tools: [editTool],
			baseToolsOverride: { edit: editTool },
		});

		await harness.session.prompt("edit");

		expect(snapshotted).toEqual([join(harness.tempDir, "src", "a.ts"), join(homedir(), "notes.md")]);
	});
});
