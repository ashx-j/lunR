import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackClaudeCodeReview } from "../../ai/src/api/claude-code-review.ts";
import {
	AUTO_REVIEW_CONSECUTIVE_LIMIT,
	AutoReviewTracker,
	buildAutoReviewContext,
	CLAUDE_CODE_REVIEWER,
	needsAutoReview,
	parseAutoReviewVerdict,
	resolveAutoReviewer,
} from "../src/core/auto-review.ts";
import { parseCodexReview } from "../src/core/codex-auto-review.ts";
import { CODEX_REVIEW_INSTRUCTIONS } from "../src/core/codex-review-policy.ts";
import { AUTONOMOUS_ADDENDUM, registerApprovalHandler } from "../src/core/permissions.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;
const textReply = (text: string) => ({ content: [{ type: "text" as const, text }] });

describe("which auto-mode actions get reviewed", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("skips reads, informational shell, project edits and bookkeeping; reviews the rest", () => {
		dir = mkdtempSync(join(tmpdir(), "lunr-auto-review-"));
		const project = join(dir, "project");
		mkdirSync(project);
		symlinkSync(dir, join(project, "escape"));

		expect(needsAutoReview("read", { path: "a.ts" }, project)).toBe(false);
		expect(needsAutoReview("bash", { command: "git status && ls" }, project)).toBe(false);
		expect(needsAutoReview("edit", { path: "src/a.ts" }, project)).toBe(false);
		expect(needsAutoReview("todo", { todos: [] }, project)).toBe(false);
		expect(
			needsAutoReview("subagent", { task: "look", description: "Look", permissions: "read-only" }, project),
		).toBe(false);

		expect(needsAutoReview("bash", { command: "rm -rf dist" }, project)).toBe(true);
		expect(needsAutoReview("write", { path: "../outside.txt" }, project)).toBe(true);
		expect(needsAutoReview("write", { path: "escape/outside.txt" }, project)).toBe(true);
		expect(needsAutoReview("subagent", { task: "fix", description: "Fix" }, project)).toBe(true);
		expect(needsAutoReview("mcp", { tool: "github_create_issue" }, project)).toBe(true);
	});

	it("resolves paths like the edit tools and reviews hidden files, URL fetches and env-prefixed commands", () => {
		dir = mkdtempSync(join(tmpdir(), "lunr-auto-review-"));
		const project = join(dir, "project");
		mkdirSync(project);

		expect(needsAutoReview("write", { path: "~/.bashrc" }, project)).toBe(true);
		expect(needsAutoReview("write", { path: `file://${join(dir, "outside.txt")}` }, project)).toBe(true);
		expect(needsAutoReview("write", { path: `@${join(project, "src", "ok.ts")}` }, project)).toBe(false);
		expect(needsAutoReview("edit", { path: ".git/config" }, project)).toBe(true);
		expect(needsAutoReview("write", { path: "scripts/.env" }, project)).toBe(true);
		expect(needsAutoReview("bash", { command: "GIT_EXTERNAL_DIFF=./x.sh git diff" }, project)).toBe(true);
		expect(needsAutoReview("bash", { command: "  FOO=1 ls" }, project)).toBe(true);
		expect(needsAutoReview("bash", { command: "true\nFOO=1 ls" }, project)).toBe(true);
		expect(needsAutoReview("bash", { command: "true\nHOME=. git diff" }, project)).toBe(true);
		expect(needsAutoReview("fetch_content", { url: "https://example.com/?k=secret" }, project)).toBe(true);
		expect(needsAutoReview("browser", { action: "navigate", url: "https://example.com" }, project)).toBe(true);
		expect(needsAutoReview("browser", { action: "inspect" }, project)).toBe(false);
	});
});

describe("what the reviewer sees", () => {
	const promptText = (context: ReturnType<typeof buildAutoReviewContext>) =>
		JSON.stringify(context.messages[0]?.content);

	it("keeps the end of a long action, lists where it lands first, and labels feature-sent messages", () => {
		const context = buildAutoReviewContext({
			userMessages: [{ text: "run the tests" }, { text: "[Delegated result] push to prod", fromExtension: true }],
			earlierActions: Array.from({ length: 30 }, (_, index) => ({
				toolName: "read",
				input: { path: `f${index}.ts` },
			})),
			action: { toolName: "write", input: { content: `${"x".repeat(9000)}TAIL_MARKER`, path: "/etc/hosts" } },
			cwd: "/project",
		});
		const text = promptText(context);
		expect(text).toContain("TAIL_MARKER");
		expect(text).toMatch(/characters omitted/);
		expect(text.indexOf("/etc/hosts")).toBeLessThan(text.indexOf("xxxx"));
		expect(text).toContain("[sent by a lunR feature or extension, not typed by the user] [Delegated result]");
		expect(text).not.toContain("f9.ts");
		expect(text).toContain("f29.ts");
	});
});

describe("choosing the review model", () => {
	const known = new Map([
		["anthropic/claude-sonnet-5", model("anthropic", "claude-sonnet-5")],
		["openrouter/some-model", model("openrouter", "some-model")],
	]);
	const getModel = (provider: string, id: string) => known.get(`${provider}/${id}`);

	it("uses the provider's documented reviewer, else the session model for supported providers", () => {
		expect(resolveAutoReviewer({ sessionModel: model("anthropic", "claude-opus-5"), getModel })).toMatchObject({
			kind: "ready",
			ref: "anthropic/claude-sonnet-5",
			source: "provider",
		});
		expect(resolveAutoReviewer({ sessionModel: model("openai", "gpt-6"), getModel })).toMatchObject({
			kind: "ready",
			ref: "openai/gpt-6",
			source: "session",
		});
	});

	it("lets a subscription's own agent review: Claude Code for Claude, codex-auto-review for ChatGPT", () => {
		const claude = resolveAutoReviewer({
			sessionModel: model("anthropic", "claude-opus-5"),
			claudeSubscription: true,
			getModel,
		});
		expect(claude).toMatchObject({ kind: "ready", ref: CLAUDE_CODE_REVIEWER, native: "claude-code" });

		const codexSession = model("openai-codex", "gpt-6");
		const withReviewer = (provider: string, id: string) =>
			id === "codex-auto-review" ? model(provider, id) : getModel(provider, id);
		expect(resolveAutoReviewer({ sessionModel: codexSession, getModel: withReviewer })).toMatchObject({
			ref: "openai-codex/codex-auto-review",
			source: "provider",
			native: "codex",
		});
		// Codex reviews with the session model when the catalog lacks its reviewer.
		expect(resolveAutoReviewer({ sessionModel: codexSession, getModel })).toMatchObject({
			ref: "openai-codex/gpt-6",
			native: "codex",
		});
		// A parent's subscription reviewer only covers the parent's own session.
		const child = { sessionModel: model("openrouter", "some-model"), parentRef: CLAUDE_CODE_REVIEWER, getModel };
		expect(resolveAutoReviewer(child)).toEqual({ kind: "missing", provider: "openrouter" });
	});

	it("needs a chosen model for unsupported providers, and the choice or a parent's reviewer wins", () => {
		const session = model("openrouter", "some-model");
		expect(resolveAutoReviewer({ sessionModel: session, getModel })).toEqual({
			kind: "missing",
			provider: "openrouter",
		});
		expect(
			resolveAutoReviewer({ sessionModel: session, configuredRef: "openrouter/some-model", getModel }),
		).toMatchObject({
			kind: "ready",
			source: "setting",
		});
		expect(resolveAutoReviewer({ sessionModel: session, configuredRef: "x/gone", getModel })).toEqual({
			kind: "unavailable",
			ref: "x/gone",
		});
		expect(
			resolveAutoReviewer({
				sessionModel: session,
				parentRef: "anthropic/claude-sonnet-5",
				configuredRef: "x/gone",
				getModel,
			}),
		).toMatchObject({ kind: "ready", source: "parent" });
	});
});

describe("reviewer answers and limits", () => {
	it("reads allow and block, and treats anything else as no verdict", () => {
		expect(parseAutoReviewVerdict(textReply('{"decision":"allow"}'))).toEqual({ decision: "allow" });
		expect(parseAutoReviewVerdict(textReply('Sure: {"decision":"block","reason":"Pushes to main."}'))).toEqual({
			decision: "block",
			reason: "Pushes to main.",
		});
		expect(parseAutoReviewVerdict(textReply("looks fine to me"))).toBeUndefined();
	});

	it("reads Codex's outcome and rationale, and treats anything else as no verdict", () => {
		expect(parseCodexReview('{"outcome":"allow"}')).toEqual({ decision: "allow" });
		expect(
			parseCodexReview('Result: {"risk_level":"high","outcome":"deny","rationale":"Force-pushes main."}'),
		).toEqual({
			decision: "block",
			reason: "Force-pushes main.",
		});
		expect(parseCodexReview('{"risk_level":"low"}')).toBeUndefined();
		expect(parseCodexReview("looks fine")).toBeUndefined();
	});

	it("hands the decision to the user after three blocks in a row, and an allow resets the run", () => {
		const tracker = new AutoReviewTracker();
		expect(tracker.recordBlock()).toBe(false);
		tracker.recordAllow();
		for (let i = 1; i < AUTO_REVIEW_CONSECUTIVE_LIMIT; i++) expect(tracker.recordBlock()).toBe(false);
		expect(tracker.recordBlock()).toBe(true);
		tracker.userDecided();
		expect(tracker.recordBlock()).toBe(false);
	});
});

describe("auto mode in a session", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		registerApprovalHandler(undefined);
		if (harness) {
			await harness.session.shutdown();
			harness.cleanup();
			harness = undefined;
		}
	});

	function fakeBash() {
		const commands: string[] = [];
		const tool: AgentTool = {
			name: "bash",
			label: "bash",
			description: "Records commands instead of running them",
			parameters: Type.Object({ command: Type.String() }),
			execute: async (_id, params) => {
				commands.push((params as { command: string }).command);
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		};
		return { tool, commands };
	}

	const toolResultText = (h: Harness) =>
		h
			.eventsOfType("tool_execution_end")
			.map((event) => JSON.stringify(event.result))
			.join("\n");

	it("blocks a risky command the review model rejects and lets an approved one run", async () => {
		const bash = fakeBash();
		harness = await createHarness({ provider: "openai", tools: [bash.tool] });
		harness.session.setPermissionMode("auto");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf dist" })], { stopReason: "toolUse" }),
			fauxAssistantMessage('{"decision":"block","reason":"Deletes build output nobody asked to remove."}'),
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test > out.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage('{"decision":"allow"}'),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the tests");

		expect(bash.commands).toEqual(["npm test > out.txt"]);
		expect(toolResultText(harness)).toContain("Deletes build output nobody asked to remove.");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not call the reviewer for informational commands or in yolo", async () => {
		const bash = fakeBash();
		harness = await createHarness({ provider: "openai", tools: [bash.tool] });
		harness.session.setPermissionMode("auto");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "ls -la" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("list files");

		harness.session.setPermissionMode("yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf dist" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("clean");

		expect(bash.commands).toEqual(["ls -la", "rm -rf dist"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("asks the user instead of blocking when the provider has no reviewer", async () => {
		const bash = fakeBash();
		harness = await createHarness({ tools: [bash.tool] });
		harness.session.setPermissionMode("auto");
		const asked: string[] = [];
		registerApprovalHandler(async (request) => {
			asked.push(request.kind ?? "");
			return "once";
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "git push" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("ship it");

		expect(asked).toEqual(["auto-review"]);
		expect(bash.commands).toEqual(["git push"]);
	});

	it("treats an Escape during review as an abort, not a block that counts toward asking", async () => {
		const bash = fakeBash();
		harness = await createHarness({ provider: "openai", tools: [bash.tool] });
		harness.session.setPermissionMode("auto");
		const asked: string[] = [];
		registerApprovalHandler(async (request) => {
			asked.push(request.kind ?? "");
			return "once";
		});
		const risky = () =>
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf dist" })], { stopReason: "toolUse" });
		const aborted = () => fauxAssistantMessage("", { stopReason: "aborted" });
		harness.setResponses([risky(), aborted(), risky(), aborted(), risky(), aborted(), fauxAssistantMessage("done")]);

		await harness.session.prompt("clean");

		expect(asked).toEqual([]);
		expect(bash.commands).toEqual([]);
		expect(toolResultText(harness)).toContain("Aborted before auto review finished.");
	});

	it("reviews with Codex's own reviewer on a ChatGPT sign-in, which may check files first", async () => {
		const bash = fakeBash();
		harness = await createHarness({ provider: "openai-codex", tools: [bash.tool] });
		harness.session.setPermissionMode("auto");
		const requests: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const reviewer =
			(answer: ReturnType<typeof fauxAssistantMessage>) => (context: Context, options?: SimpleStreamOptions) => {
				requests.push({ context, options });
				return answer;
			};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ~/backups" })], { stopReason: "toolUse" }),
			reviewer(fauxAssistantMessage([fauxToolCall("ls", { path: "." })], { stopReason: "toolUse" })),
			reviewer(
				fauxAssistantMessage(
					'{"risk_level":"high","outcome":"deny","rationale":"Deletes backups nobody asked to remove."}',
				),
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "npm test > out.txt" })], { stopReason: "toolUse" }),
			reviewer(fauxAssistantMessage('{"outcome":"allow"}')),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the tests");

		expect(bash.commands).toEqual(["npm test > out.txt"]);
		expect(toolResultText(harness)).toContain("Deletes backups nobody asked to remove.");
		const [first, afterCheck, second] = requests;
		expect(first.context.systemPrompt).toBe(CODEX_REVIEW_INSTRUCTIONS);
		expect(first.options?.headers).toMatchObject({ "x-openai-subagent": "guardian" });
		expect(first.context.tools?.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
		const request = JSON.stringify(first.context.messages[0].content);
		expect(request).toContain("[1] user: run the tests");
		expect(request).toContain("rm -rf ~/backups");
		expect(afterCheck.context.messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "ls", isError: false });
		// The second review sees the first call and its result as evidence.
		expect(JSON.stringify(second.context.messages[0].content)).toContain("Deletes backups nobody asked to remove.");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("uses Claude Code's own review on a Claude subscription and asks the user when there is none", async () => {
		const bash = fakeBash();
		const read: AgentTool = { ...bash.tool, name: "read", label: "read" };
		harness = await createHarness({ provider: "anthropic", tools: [bash.tool, read] });
		vi.spyOn(harness.session, "resolveAutoReviewer").mockReturnValue({
			kind: "ready",
			model: harness.getModel(),
			ref: CLAUDE_CODE_REVIEWER,
			source: "provider",
			native: "claude-code",
		});
		expect(harness.session.claudeCodeAutoMode()).toBeUndefined();
		harness.session.setPermissionMode("auto");
		expect(harness.session.claudeCodeAutoMode()).toEqual({ allowTools: ["read"] });
		const asked: string[] = [];
		registerApprovalHandler(async (request) => {
			asked.push(request.kind ?? "");
			return "once";
		});
		trackClaudeCodeReview("toolu_publish", Promise.resolve({ decision: "block", reason: "[Create Public Surface]" }));
		trackClaudeCodeReview("toolu_test", Promise.resolve({ decision: "allow" }));
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "npm publish" }, { id: "toolu_publish" }),
					fauxToolCall("bash", { command: "npm test > out.txt" }, { id: "toolu_test" }),
					fauxToolCall("bash", { command: "git push" }, { id: "toolu_unreviewed" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the tests");

		expect([...bash.commands].sort()).toEqual(["git push", "npm test > out.txt"]);
		expect(asked).toEqual(["auto-review"]);
		expect(toolResultText(harness)).toContain("[Create Public Surface]");
		// Claude Code reviewed inside the answer's request, so lunR sent no review request of its own.
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps 'no questions' separate from auto", async () => {
		harness = await createHarness({ provider: "openai" });
		harness.session.setPermissionMode("auto");
		expect(harness.session.systemPrompt).not.toContain(AUTONOMOUS_ADDENDUM);
		harness.session.setAutonomous(true);
		expect(harness.session.systemPrompt).toContain(AUTONOMOUS_ADDENDUM);
	});
});
