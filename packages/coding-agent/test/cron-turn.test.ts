import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import lunrCron from "../src/builtin-extensions/lunr-cron.ts";
import {
	createJob,
	getJob,
	getLatestJobOutput,
	resetCronValidators,
	setCronBaseDir,
	setCronWorkdirRoots,
} from "../src/core/cron/jobs.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(async () => {
	if (harness) {
		await harness.session.shutdown();
		harness.cleanup();
		harness = undefined;
	}
	setCronBaseDir(undefined);
	resetCronValidators();
	vi.unstubAllEnvs();
});

function heldTool(name: string) {
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tool: AgentTool = {
		name,
		label: name,
		description: "Inert held tool",
		parameters: Type.Object({}),
		execute: async () => {
			enter();
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	return { tool, entered, release: () => release() };
}

it("TUI cron saves only its admitted output while a queued user follow-up is still running", async () => {
	for (const key of Object.keys(process.env))
		if (/^PI_(SUBAGENT|SUBAGENTS|INTERCOM)_/.test(key)) vi.stubEnv(key, undefined);
	const scheduled = heldTool("scheduled_wait");
	const user = heldTool("user_wait");
	let ctx!: ExtensionContext;
	harness = await createHarness({
		tools: [scheduled.tool, user.tool],
		extensionFactories: [
			lunrCron,
			(pi) => {
				pi.on("session_start", (_event, context) => {
					ctx = context;
				});
			},
		],
	});
	vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
	setCronBaseDir(harness.tempDir);
	setCronWorkdirRoots([harness.tempDir]);
	await harness.session.bindExtensions({ mode: "tui" });
	const job = await createJob({ prompt: "scheduled task", schedule: "30m", workdir: harness.tempDir });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("scheduled_wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("scheduled result"),
		fauxAssistantMessage([fauxToolCall("user_wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("private later user result"),
	]);
	const command = harness.session.prompt(`/cron run ${job.id}`);
	await scheduled.entered;
	await harness.session.prompt("later user question", { streamingBehavior: "followUp" });
	scheduled.release();
	await user.entered;
	await command;
	expect(getLatestJobOutput(job.id)).toBe("scheduled result");
	expect(getJob(job.id).repeat.completed).toBe(1);
	user.release();
	await harness.session.waitForIdle();
	expect(getLatestJobOutput(job.id)).toBe("scheduled result");
	expect(
		harness.session.messages.some((message) => JSON.stringify(message).includes("private later user result")),
	).toBe(true);
	expect(ctx.promptWithCompletion).toBeTypeOf("function");
});

it("a busy TUI manual run cannot capture the ordinary user answer", async () => {
	const user = heldTool("user_wait");
	harness = await createHarness({ tools: [user.tool], extensionFactories: [lunrCron] });
	vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
	setCronBaseDir(harness.tempDir);
	setCronWorkdirRoots([harness.tempDir]);
	await harness.session.bindExtensions({ mode: "tui" });
	const job = await createJob({ prompt: "scheduled task", schedule: "30m", workdir: harness.tempDir });
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("user_wait", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("private user answer"),
	]);
	const prompt = harness.session.prompt("user question");
	await user.entered;
	await harness.session.prompt(`/cron run ${job.id}`);
	user.release();
	await prompt;
	expect(getJob(job.id).repeat.completed).toBe(0);
	expect(getLatestJobOutput(job.id)).toBeNull();
});

it("an admitted provider busy failure stays terminal instead of deferring a replay", async () => {
	harness = await createHarness({ settings: { retry: { enabled: false } }, extensionFactories: [lunrCron] });
	vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
	setCronBaseDir(harness.tempDir);
	setCronWorkdirRoots([harness.tempDir]);
	await harness.session.bindExtensions({ mode: "tui" });
	const job = await createJob({ prompt: "scheduled task", schedule: "30m", workdir: harness.tempDir });
	harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "server busy after effects" })]);
	await harness.session.prompt(`/cron run ${job.id}`);
	expect(getJob(job.id).repeat.completed).toBe(1);
	expect(getJob(job.id).lastStatus).toBe("error");
	expect(getJob(job.id).lastError).toBe("server busy after effects");
	expect(getJob(job.id).activeRun).toBeUndefined();
});

it.each(["different", "legacy"])("does not admit a %s-project job into the owning TUI", async (kind) => {
	const project = mkdtempSync(join(tmpdir(), "lunr-cron-other-project-"));
	try {
		harness = await createHarness({ extensionFactories: [lunrCron] });
		vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
		setCronBaseDir(harness.tempDir);
		setCronWorkdirRoots([harness.tempDir]);
		setCronWorkdirRoots([harness.tempDir, project]);
		await harness.session.bindExtensions({ mode: "tui" });
		const job = await createJob({
			prompt: "task in its saved project",
			schedule: "30m",
			workdir: kind === "legacy" ? undefined : project,
		});
		harness.setResponses([fauxAssistantMessage("must not be consumed")]);
		await harness.session.prompt(`/cron run ${job.id}`);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getJob(job.id).repeat.completed).toBe(0);
		expect(getJob(job.id).nextRunAt).toBe(job.nextRunAt);
		expect(getJob(job.id).activeRun).toBeUndefined();
		expect(getLatestJobOutput(job.id)).toBeNull();
		// Ordinary user work remains available after this admission refusal.
		harness.setResponses([fauxAssistantMessage("ordinary user result")]);
		await harness.session.prompt("ordinary user question");
		expect(harness.session.messages.some((message) => JSON.stringify(message).includes("ordinary user result"))).toBe(
			true,
		);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

it("allows a saved symlink alias of the owning TUI's actual project", async () => {
	harness = await createHarness({ extensionFactories: [lunrCron] });
	vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
	setCronBaseDir(harness.tempDir);
	setCronWorkdirRoots([harness.tempDir]);
	const alias = join(harness.tempDir, "project-alias");
	symlinkSync(harness.tempDir, alias, process.platform === "win32" ? "junction" : "dir");
	setCronWorkdirRoots([harness.tempDir]);
	await harness.session.bindExtensions({ mode: "tui" });
	const job = await createJob({ prompt: "same canonical project", schedule: "30m", workdir: alias });
	harness.setResponses([fauxAssistantMessage("correct project result")]);
	await harness.session.prompt(`/cron run ${job.id}`);
	expect(getLatestJobOutput(job.id)).toBe("correct project result");
	expect(getJob(job.id).lastStatus).toBe("ok");
});

it.runIf(process.platform === "win32")("matches saved project paths with equivalent Windows casing", async () => {
	harness = await createHarness({ extensionFactories: [lunrCron] });
	vi.stubEnv("PI_CODING_AGENT_DIR", harness.tempDir);
	setCronBaseDir(harness.tempDir);
	setCronWorkdirRoots([harness.tempDir.toUpperCase()]);
	await harness.session.bindExtensions({ mode: "tui" });
	const job = await createJob({ prompt: "same project", schedule: "30m", workdir: harness.tempDir.toUpperCase() });
	harness.setResponses([fauxAssistantMessage("correct project result")]);
	await harness.session.prompt(`/cron run ${job.id}`);
	expect(getLatestJobOutput(job.id)).toBe("correct project result");
});
