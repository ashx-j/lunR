import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acpWorkerArgs } from "../src/modes/acp/args.ts";
import { customMessageContent, promptToLunr } from "../src/modes/acp/translate.ts";

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
});
