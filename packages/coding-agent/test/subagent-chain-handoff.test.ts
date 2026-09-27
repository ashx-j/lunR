import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSingleStep } from "../src/builtin-extensions/pi-subagents/src/runs/background/subagent-runner.ts";
import { executeChain } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/chain-execution.ts";
import { runSync } from "../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts";
import { withChainHandoff } from "../src/builtin-extensions/pi-subagents/src/runs/shared/chain-outputs.ts";

vi.mock("../src/builtin-extensions/pi-subagents/src/runs/foreground/execution.ts", () => ({ runSync: vi.fn() }));

const handoff =
	"Your final output will be handed to the next agent. Briefly summarize results, relevant references, verification, and remaining work.";

describe("chain child handoff prompt", () => {
	it("adds a brief notice to intermediate foreground chain child tasks, not terminal tasks", () => {
		expect(withChainHandoff("Inspect the report", true)).toBe(`Inspect the report\n\n${handoff}`);
		expect(withChainHandoff("Finish the report", false)).toBe("Finish the report");
	});

	it("notifies only producing foreground chain children, including parallel groups", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-foreground-handoff-"));
		try {
			vi.mocked(runSync).mockImplementation(async (_cwd, spec) => ({
				agent: spec.description,
				task: spec.task,
				finalOutput: "result",
				exitCode: 0,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			}));
			const steps = [
				{ agent: "First", description: "First", task: "Inspect", model: "test/model" },
				{
					parallel: [
						{ agent: "A", description: "A", task: "Check A", model: "test/model" },
						{ agent: "B", description: "B", task: "Check B", model: "test/model" },
					],
				},
				{ agent: "Last", description: "Last", task: "Report", model: "test/model" },
			];
			const result = await executeChain({
				chain: steps,
				agents: steps.flatMap((step) =>
					"parallel" in step
						? step.parallel.map((child) => ({
								name: child.agent,
								systemPrompt: "",
								systemPromptMode: "append",
								inheritProjectContext: true,
								inheritSkills: false,
							}))
						: [
								{
									name: step.agent,
									systemPrompt: "",
									systemPromptMode: "append",
									inheritProjectContext: true,
									inheritSkills: false,
								},
							],
				),
				ctx: {
					cwd: dir,
					modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] },
					sessionManager: { getSessionId: () => "session" },
				} as never,
				runId: "handoff",
				shareEnabled: false,
				sessionDirForIndex: () => undefined,
				artifactsDir: dir,
				artifactConfig: { enabled: false },
				controlConfig: {} as never,
				maxSubagentDepth: 1,
			} as never);
			expect(result.isError).not.toBe(true);
			const tasks = vi.mocked(runSync).mock.calls.map(([, spec]) => spec.task);
			expect(tasks).toHaveLength(4);
			for (const task of tasks.slice(0, 3)) expect(task).toContain(handoff);
			expect(tasks[3]).not.toContain(handoff);
		} finally {
			vi.mocked(runSync).mockReset();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([true, false])(
		"passes the conditional notice to an async child when handoff is %s",
		async (handoffToNext) => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-chain-handoff-"));
			try {
				fs.writeFileSync(
					path.join(dir, "package.json"),
					JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "child.cjs" }),
				);
				fs.writeFileSync(
					path.join(dir, "child.cjs"),
					`require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, "prompt.json"))}, JSON.stringify(process.argv.at(-1))); console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}}));`,
				);
				const result = await runSingleStep(
					{
						agent: "Review",
						task: "Review {previous}",
						permissions: "read-only",
						inheritProjectContext: true,
						inheritSkills: false,
					},
					{
						previousOutput: "source material",
						handoffToNext,
						placeholder: "{previous}",
						cwd: dir,
						sessionEnabled: false,
						id: "handoff-run",
						flatIndex: 0,
						flatStepCount: 2,
						outputFile: path.join(dir, "output.log"),
						piPackageRoot: dir,
						piArgv1: path.join(dir, "child.cjs"),
					},
				);
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(fs.readFileSync(path.join(dir, "prompt.json"), "utf-8"))).toBe(
					`Task: ${withChainHandoff("Review source material", handoffToNext)}`,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
