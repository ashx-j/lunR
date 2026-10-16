import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCompletionDetails,
	formatSingleCompletion,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/notify.ts";
import { acpWorkerArgs } from "../src/modes/acp/args.ts";
import { customMessageContent, customMessageUpdates, modelOptions, promptToLunr } from "../src/modes/acp/translate.ts";

describe("ACP command and content boundaries", () => {
	it("resolves launch paths before switching to a client project", () => {
		expect(
			acpWorkerArgs([
				"--mode",
				"acp",
				"--extension",
				"./plugin.ts",
				"--skill",
				"npm:skills",
				"--system-prompt",
				"--mode",
			]),
		).toEqual(["--extension", resolve("plugin.ts"), "--skill", "npm:skills", "--system-prompt", "--mode"]);
	});

	it("treats launch model and reasoning as new-session defaults", () => {
		expect(
			acpWorkerArgs(["--model", "provider/model", "--thinking", "low", "--name", "first", "--offline"], true),
		).toEqual(["--offline"]);
	});

	it("rejects a CLI-owned conversation in ACP mode", () => {
		expect(() => acpWorkerArgs(["--session", "/tmp/session.jsonl"])).toThrow("clients own prompts");
		expect(() => acpWorkerArgs(["do some work"])).toThrow("clients own prompts");
	});

	it("preserves image and embedded text attachments", () => {
		expect(
			promptToLunr([
				{ type: "text", text: "review" },
				{ type: "resource", resource: { uri: "file:///project/notes.txt", text: "attached context" } },
				{ type: "image", data: "image-data", mimeType: "image/png" },
			]),
		).toEqual({
			message: "review\n[embedded context] file:///project/notes.txt\nattached context",
			images: [{ type: "image", data: "image-data", mimeType: "image/png" }],
		});
	});

	it("rejects unsupported attachments instead of silently dropping them", () => {
		expect(() => promptToLunr([{ type: "audio", data: "audio", mimeType: "audio/wav" }])).toThrow("audio");
		expect(() => promptToLunr([{ type: "resource", resource: { uri: "file:///file.pdf", blob: "binary" } }])).toThrow(
			"Binary",
		);
	});

	it("exposes final native subagent cards without exposing unrelated hidden messages", () => {
		const message = {
			role: "custom" as const,
			customType: "internal",
			content: "private context",
			display: false,
			timestamp: 0,
		};
		expect(customMessageContent(message)).toEqual([]);
		expect(
			customMessageContent({ ...message, customType: "subagent-slash-result", content: "child report" }),
		).toEqual([{ type: "text", text: "child report" }]);
	});

	it.each([
		{ state: "complete", success: true, status: "completed" },
		{ state: "failed", success: false, status: "failed" },
		{ state: "paused", success: false, status: "failed" },
		{ state: "stopped", success: false, status: "failed" },
	])("preserves the outcome of a $state native child notice", ({ state, success, status }) => {
		const content = formatSingleCompletion(
			buildCompletionDetails({
				id: "fixture-run",
				agent: "fixture child",
				success,
				state,
				summary: "native outcome",
				timestamp: 0,
			}),
		);
		expect(
			customMessageUpdates({
				role: "custom",
				customType: "subagent-notify",
				content,
				display: true,
				timestamp: 0,
			}),
		).toEqual([expect.objectContaining({ sessionUpdate: "tool_call", status })]);
	});

	describe("model picker labels", () => {
		const model = (provider: string, id: string, name: string) => ({ provider, id, name });
		const labels = (models: ReturnType<typeof model>[]) => modelOptions(models).map((option) => option.name);

		it("keeps unique names plain and values as provider/id", () => {
			const options = modelOptions([model("a", "x", "Alpha"), model("b", "y", "Beta")]);
			expect(options).toEqual([
				{ value: "a/x", name: "Alpha" },
				{ value: "b/y", name: "Beta" },
			]);
		});

		it("adds the provider when a name appears under different providers", () => {
			expect(labels([model("a", "x", "Same"), model("b", "x", "Same"), model("a", "z", "Other")])).toEqual([
				"Same (a)",
				"Same (b)",
				"Other",
			]);
		});

		it("adds the id when a name repeats within one provider", () => {
			expect(labels([model("a", "x", "Same"), model("a", "y", "Same")])).toEqual(["Same (a/x)", "Same (a/y)"]);
		});

		it("disambiguates only the colliding entries in a three-way collision", () => {
			expect(labels([model("a", "x", "Same"), model("b", "x", "Same"), model("b", "y", "Same")])).toEqual([
				"Same (a)",
				"Same (b/x)",
				"Same (b/y)",
			]);
		});
	});
});
