import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSingleStep } from "../src/builtin-extensions/pi-subagents/src/runs/background/subagent-runner.ts";
import { parseSessionTokens } from "../src/builtin-extensions/pi-subagents/src/shared/session-tokens.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { collectChildUsage, totalChildUsage, totalRequestUsage } from "../src/core/usage-accounting.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "lunr-usage-child-"));
	dirs.push(dir);
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir);
	const child = join(dir, "child.cjs");
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: "child.cjs" }),
	);
	writeFileSync(
		child,
		`
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const args=process.argv; const arg=(name)=>args[args.indexOf(name)+1];
 const model=arg('--model'); const failed=model==='fixture/first';
 const usage={input:100,output:200,cacheRead:10000,cacheWrite:1000,totalTokens:11300,measurement:'reported',requestId:crypto.randomUUID(),cost:{input:0.1,output:0.2,cacheRead:0.3,cacheWrite:0.4,total:1}};
 const message={role:'assistant',content:[{type:'text',text:'done'}],api:'openai-responses',provider:'fixture',model,usage,timestamp:Date.now(),stopReason:failed?'error':'stop',...(failed?{errorMessage:'429 rate limit'}:{})};
 const timestamp=new Date().toISOString(); const entry={type:'message',id:crypto.randomUUID(),parentId:null,timestamp,message};
 const auxiliary={type:'custom',customType:'request-usage',id:crypto.randomUUID(),parentId:entry.id,timestamp,data:{id:crypto.randomUUID(),purpose:'title',provider:'fixture',model,timestamp:Date.now(),stopReason:'stop',usage:{...usage,requestId:undefined,input:20,output:10,cacheRead:0,cacheWrite:0,totalTokens:30,cost:{input:0.1,output:0.2,cacheRead:0,cacheWrite:0,total:0.3}}}};
 const file=args.includes('--session')?arg('--session'):path.join(arg('--session-dir'),timestamp.replace(/[:.]/g,'-')+'_'+crypto.randomUUID()+'.jsonl');
 fs.appendFileSync(file,[entry,auxiliary].map(JSON.stringify).join('\\n')+'\\n');
 console.log(JSON.stringify({type:'message_end',message}));
 console.log(JSON.stringify({type:'agent_end',messages:[message],willRetry:false}));
 process.exitCode=failed?1:0;
 `,
	);
	const ctx = {
		previousOutput: "",
		placeholder: "{previous}",
		cwd: dir,
		sessionEnabled: true,
		sessionDir,
		id: "usage-run",
		flatIndex: 0,
		flatStepCount: 2,
		outputFile: join(dir, "output.log"),
		piPackageRoot: dir,
		piArgv1: child,
	};
	return { dir, sessionDir, ctx };
}

describe("child request receipts", () => {
	it("counts failed fallback attempts and auxiliary requests across separate session files", async () => {
		const { ctx, sessionDir } = fixture();
		const result = await runSingleStep(
			{
				agent: "review",
				task: "review",
				permissions: "read-only",
				modelCandidates: ["fixture/first", "fixture/second"],
			},
			ctx,
		);
		expect(result.exitCode, result.error).toBe(0);
		expect(result.modelAttempts).toHaveLength(2);
		for (const attempt of result.modelAttempts ?? [])
			expect(attempt.usage).toMatchObject({ input: 120, output: 210, cacheRead: 10000, cacheWrite: 1000 });
		for (const attempt of result.modelAttempts ?? []) expect(attempt.usage?.cost).toBeCloseTo(1.3);
		expect(result.totalCost?.costUsd).toBeCloseTo(2.6);
		expect(result.totalCost).toMatchObject({ inputTokens: 22240, outputTokens: 420 });
		expect(parseSessionTokens(sessionDir)?.total).toBe(22660);
		expect(result.sessionFile).toBeDefined();
	});
	it("keeps per-attempt usage separate from cumulative resume receipts", async () => {
		const { ctx } = fixture();
		const initial = await runSingleStep(
			{ agent: "review", task: "review", permissions: "read-only", model: "fixture/second" },
			ctx,
		);
		const sessionFile = initial.sessionFile!;
		const resumed = await runSingleStep(
			{ agent: "review", task: "continue", permissions: "read-only", model: "fixture/second", sessionFile },
			{ ...ctx, id: "resume-run", outputFile: join(ctx.cwd, "resume.log") },
		);
		expect(resumed.exitCode, resumed.error).toBe(0);
		expect(resumed.modelAttempts?.[0]?.usage).toMatchObject({
			input: 120,
			output: 210,
			cacheRead: 10000,
			cacheWrite: 1000,
		});
		expect(resumed.modelAttempts?.[0]?.usage?.cost).toBeCloseTo(1.3);
		expect(resumed.receiptUsage?.cost).toBeCloseTo(2.6);
		expect(resumed.receiptUsage).toMatchObject({ input: 240, output: 420, cacheRead: 20000, cacheWrite: 2000 });
		expect(readFileSync(sessionFile, "utf-8").trim().split("\n")).toHaveLength(4);
	});
	it("deduplicates fallback receipts when resuming the last attempt and repeating notifications", async () => {
		const { ctx } = fixture();
		const initial = await runSingleStep(
			{
				agent: "review",
				task: "review",
				permissions: "read-only",
				modelCandidates: ["fixture/first", "fixture/second"],
			},
			ctx,
		);
		const resumed = await runSingleStep(
			{
				agent: "review",
				task: "continue",
				permissions: "read-only",
				model: "fixture/second",
				sessionFile: initial.sessionFile,
			},
			{ ...ctx, id: "resume-run", outputFile: join(ctx.cwd, "resume.log") },
		);
		const parent = SessionManager.inMemory(ctx.cwd);
		try {
			for (const result of [initial, resumed, initial, resumed]) {
				const requests = result.usageRequests!;
				expect(requests).toHaveLength(4);
				parent.appendCustomMessageEntry("subagent-notify", "done", true, {
					children: [
						{
							childId: "review",
							sessionFile: result.sessionFile,
							usage: totalRequestUsage(requests),
							usageRequests: requests,
						},
					],
				});
			}
			const total = totalChildUsage(collectChildUsage(parent.getEntries()));
			expect(total.total).toBe(33990);
			expect(total.cost).toBeCloseTo(3.9);
			const inherited = parent
				.getEntries()
				.slice(0, 1)
				.map((entry) => ({ ...entry, inherited: true }));
			const fork = [...inherited, ...parent.getEntries().slice(1)];
			expect(totalChildUsage(collectChildUsage(fork)).total).toBe(11330);
		} finally {
			parent.dispose();
		}
	});
});
