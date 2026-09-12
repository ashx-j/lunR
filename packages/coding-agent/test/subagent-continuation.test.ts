import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getBrokerLaunchSpec,
	isNativeSupervisorChannelActive,
	resolveBrokerScriptPath,
	spawnBrokerIfNeeded,
} from "../src/builtin-extensions/pi-intercom/broker/spawn.ts";
import piIntercomExtension from "../src/builtin-extensions/pi-intercom/index.ts";
import {
	createNativeSupervisorChannel,
	hasPendingBlockingSupervisorRequest,
	NATIVE_SUPERVISOR_TOOL_NAME,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../src/builtin-extensions/pi-subagents/src/intercom/native-supervisor-channel.ts";
import { resolveAsyncSingleAcceptance } from "../src/builtin-extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
	buildRevivedAsyncTask,
	readAsyncRecoveryDescriptor,
} from "../src/builtin-extensions/pi-subagents/src/runs/background/async-resume.ts";
import { waitForSubagents } from "../src/builtin-extensions/pi-subagents/src/runs/background/subagent-wait.ts";
import {
	evaluateAcceptance,
	resolveEffectiveAcceptance,
	restorePersistedAcceptance,
	validateAcceptanceInput,
	validatePersistedAcceptance,
} from "../src/builtin-extensions/pi-subagents/src/runs/shared/acceptance.ts";
import type {
	AcceptanceReport,
	ResolvedAcceptanceConfig,
	SubagentState,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";

const REVIEWED_EVIDENCE = [
	"changed-files",
	"tests-added",
	"commands-run",
	"validation-output",
	"residual-risks",
	"no-staged-files",
] as const;

const INFERRED_REVIEWED_ACCEPTANCE: ResolvedAcceptanceConfig = {
	level: "reviewed",
	explicit: false,
	inferredReason: ["async write-capable or risky run"],
	criteria: [
		{
			id: "criterion-1",
			must: "Implement the requested change without widening scope",
			evidence: [...REVIEWED_EVIDENCE],
			severity: "required",
		},
		{
			id: "criterion-2",
			must: "Return evidence sufficient for an independent acceptance review",
			evidence: [...REVIEWED_EVIDENCE],
			severity: "required",
		},
	],
	evidence: [...REVIEWED_EVIDENCE],
	verify: [],
	stopRules: [],
};

const CHECKED_RAISED_REVIEWED_ACCEPTANCE: ResolvedAcceptanceConfig = {
	...INFERRED_REVIEWED_ACCEPTANCE,
	explicit: true,
};

const CONTROL_CONFIG = {
	enabled: true,
	needsAttentionAfterMs: 60000,
	activeNoticeAfterMs: 240000,
	failedToolAttemptsBeforeAttention: 3,
	notifyOn: ["active_long_running", "needs_attention"],
	notifyChannels: ["event", "async", "intercom"],
};

const ARTIFACT_CONFIG = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeTranscript: true,
	includeMetadata: true,
	cleanupDays: 7,
};

const envKeys = [
	"PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_CHILD_INDEX",
	"PI_SUBAGENT_ORCHESTRATOR_TARGET",
	"PI_SUBAGENT_ORCHESTRATOR_SESSION_ID",
	"PI_SUBAGENT_INTERCOM_SESSION_NAME",
	"PI_INTERCOM_ASK_TIMEOUT_MS",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of envKeys) originalEnv[key] = process.env[key];

afterEach(() => {
	for (const key of envKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

function writeDescriptor(
	dir: string,
	extras: Record<string, unknown> = {},
	acceptance: unknown = INFERRED_REVIEWED_ACCEPTANCE,
): string {
	fs.mkdirSync(dir, { recursive: true });
	const descriptor = {
		version: 4,
		lifecycleArtifactVersion: 4,
		sourceRunId: "62cd5e2c-498a-41a2-b1ae-b9033a3ee3cd",
		childId: "4970b7a6-0",
		description: "Implement native computer use on a new branch",
		permissions: "full",
		agent: "Implement native computer use on a new branch",
		sessionFile: path.join(dir, "session.jsonl"),
		cwd: dir,
		model: "openai-codex/gpt-6-astra:medium",
		tier: "heavy",
		modelSelection: { kind: "tier", tier: "heavy" },
		outputMode: "inline",
		acceptance,
		controlConfig: CONTROL_CONFIG,
		maxSubagentDepth: 2,
		share: false,
		sessionDir: path.join(dir, "session"),
		artifactsDir: path.join(dir, "artifacts"),
		artifactConfig: ARTIFACT_CONFIG,
		...extras,
	};
	fs.writeFileSync(path.join(dir, "recovery-descriptor.json"), JSON.stringify(descriptor));
	return dir;
}

function completeReport(overrides: Partial<AcceptanceReport> = {}): AcceptanceReport {
	return {
		criteriaSatisfied: [
			{ id: "criterion-1", status: "satisfied", evidence: "implemented the requested change" },
			{ id: "criterion-2", status: "satisfied", evidence: "included the structured report" },
		],
		changedFiles: ["src/file.ts"],
		testsAddedOrUpdated: ["test/file.test.ts"],
		commandsRun: [{ command: "vitest", result: "passed", summary: "focused tests passed" }],
		validationOutput: ["tsgo passed"],
		residualRisks: ["none"],
		noStagedFiles: true,
		diffSummary: "small continuation repair",
		reviewFindings: ["no blockers"],
		...overrides,
	};
}

function reportOutput(report: AcceptanceReport): string {
	return `done\n\n\`\`\`acceptance-report\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function fakePi() {
	const tools = new Map<string, { name: string; execute: (...args: never[]) => unknown }>();
	const messages: unknown[] = [];
	return {
		tools,
		messages,
		on() {},
		registerMessageRenderer() {},
		registerTool(tool: { name: string; execute: (...args: never[]) => unknown }) {
			tools.set(tool.name, tool);
		},
		getAllTools() {
			return [...tools.values()];
		},
		registerCommand() {},
		registerShortcut() {},
		appendEntry() {},
		sendMessage(message: unknown) {
			messages.push(message);
		},
		events: {
			emit() {},
			on() {
				return () => {};
			},
		},
	};
}

describe("async recovery descriptor reader", () => {
	it("accepts the inferred reviewed shape from real async descriptors", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-inferred-"));
		try {
			writeDescriptor(dir, { sourceRunId: "62cd5e2c-498a-41a2-b1ae-b9033a3ee3cd" }, INFERRED_REVIEWED_ACCEPTANCE);
			const parsed = readAsyncRecoveryDescriptor(dir);
			expect(parsed?.acceptance).toMatchObject({
				level: "reviewed",
				explicit: false,
				inferredReason: ["async write-capable or risky run"],
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts the parent-checked shape that persisted explicit reviewed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-checked-"));
		try {
			writeDescriptor(
				dir,
				{
					sourceRunId: "39187cd4-97f4-4521-b38a-b5c89d82a4a6",
					childId: "5e001421-0",
					description: "Continue native computer use implementation",
					agent: "Continue native computer use implementation",
				},
				CHECKED_RAISED_REVIEWED_ACCEPTANCE,
			);
			const parsed = readAsyncRecoveryDescriptor(dir);
			expect(parsed?.acceptance).toMatchObject({
				level: "reviewed",
				explicit: true,
				inferredReason: ["async write-capable or risky run"],
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects version 3 descriptors and unknown fields that are not resolved leftovers", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-reject-"));
		try {
			writeDescriptor(dir, { version: 3 });
			expect(() => readAsyncRecoveryDescriptor(dir)).toThrow(/version must be 4/);
			writeDescriptor(dir, { unexpectedField: true });
			expect(() => readAsyncRecoveryDescriptor(dir)).toThrow(/unknown field 'unexpectedField'/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores runtime turn-budget leftovers instead of failing resume", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-recovery-turns-"));
		try {
			writeDescriptor(dir, {
				initialTurnBudget: {
					maxTurns: 8,
					graceTurns: 1,
					outcome: "within-budget",
					turnCount: 3,
				},
			});
			const parsed = readAsyncRecoveryDescriptor(dir);
			expect(parsed?.initialTurnBudget).toEqual({ maxTurns: 8, graceTurns: 1 });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resume restores resolved acceptance", () => {
	it("keeps explicit false and does not re-infer from the revival wrapper task", () => {
		const restored = restorePersistedAcceptance(INFERRED_REVIEWED_ACCEPTANCE);
		expect(restored.explicit).toBe(false);
		expect(restored.level).toBe("reviewed");
		const wrapper = buildRevivedAsyncTask(
			{
				kind: "revive",
				runId: "62cd5e2c-498a-41a2-b1ae-b9033a3ee3cd",
				state: "failed",
				agent: "Implement native computer use on a new branch",
				index: 0,
				intercomTarget: "child",
			},
			"please continue the previous work",
		);
		const reconstructed = resolveAsyncSingleAcceptance({
			restoredAcceptance: restored,
			launchAcceptance: { level: "checked" },
			task: wrapper,
			permissions: "full",
			agentName: "Implement native computer use on a new branch",
		});
		expect(reconstructed).toMatchObject({
			level: "reviewed",
			explicit: false,
			inferredReason: ["async write-capable or risky run"],
		});
		const relaunched = resolveEffectiveAcceptance({
			explicit: INFERRED_REVIEWED_ACCEPTANCE,
			task: wrapper,
			permissions: "full",
			async: true,
		});
		expect(relaunched.explicit).toBe(true);
	});
});

describe("checked vs inferred reviewed", () => {
	it("rejects launch acceptance reviewed without an independent reviewer", () => {
		expect(validateAcceptanceInput("reviewed").join(" ")).toMatch(/independent reviewer/);
		expect(validateAcceptanceInput({ level: "reviewed" }).join(" ")).toMatch(/independent reviewer/);
		expect(validatePersistedAcceptance(INFERRED_REVIEWED_ACCEPTANCE)).toEqual([]);
	});

	it("does not treat parent checked on an async write task as explicit reviewed", () => {
		const resolved = resolveEffectiveAcceptance({
			explicit: "checked",
			permissions: "full",
			task: "Implement native computer use on a new branch",
			async: true,
		});
		expect(resolved.level).toBe("reviewed");
		expect(resolved.explicit).toBe(false);
	});
});

describe("evaluateAcceptance continuation gates", () => {
	it("still rejects criterion-1 not-satisfied", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-accept-crit-"));
		try {
			const ledger = await evaluateAcceptance({
				acceptance: restorePersistedAcceptance(INFERRED_REVIEWED_ACCEPTANCE),
				output: reportOutput(
					completeReport({
						criteriaSatisfied: [
							{ id: "criterion-1", status: "not-satisfied", evidence: "scope widened" },
							{ id: "criterion-2", status: "satisfied", evidence: "report present" },
						],
					}),
				),
				cwd,
			});
			expect(ledger.status).toBe("rejected");
			expect(
				ledger.runtimeChecks.some((check) => check.id === "criterion:criterion-1" && check.status === "failed"),
			).toBe(true);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not fail inferred reviewed solely for a missing reviewer", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-accept-inferred-"));
		try {
			const ledger = await evaluateAcceptance({
				acceptance: restorePersistedAcceptance(INFERRED_REVIEWED_ACCEPTANCE),
				output: reportOutput(completeReport()),
				cwd,
			});
			expect(ledger.status).not.toBe("rejected");
			expect(ledger.reviewResult?.findings[0]?.severity).toBe("non-blocking");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still fails parent-requested reviewed without a reviewer", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-accept-explicit-"));
		try {
			const ledger = await evaluateAcceptance({
				acceptance: restorePersistedAcceptance(CHECKED_RAISED_REVIEWED_ACCEPTANCE),
				output: reportOutput(completeReport()),
				cwd,
			});
			expect(ledger.status).toBe("rejected");
			expect(ledger.reviewResult?.findings[0]?.severity).toBe("blocker");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not fail parent checked on an async write task solely for a missing reviewer", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-accept-checked-"));
		try {
			const acceptance = resolveEffectiveAcceptance({
				explicit: "checked",
				permissions: "full",
				task: "Implement native computer use on a new branch",
				async: true,
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: reportOutput(completeReport()),
				cwd,
			});
			expect(acceptance.level).toBe("reviewed");
			expect(acceptance.explicit).toBe(false);
			expect(ledger.status).not.toBe("rejected");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("broker launch spec", () => {
	it("uses node and broker.js on a compiled tree", () => {
		const linux = getBrokerLaunchSpec(
			"/opt/lunr/broker.js",
			"npx",
			["--no-install", "tsx"],
			"/opt/lunr",
			"linux",
			"/tmp/intercom",
			"/usr/bin/node",
		);
		expect(linux).toEqual({
			kind: "direct",
			command: "/usr/bin/node",
			args: ["/opt/lunr/broker.js"],
		});

		const windows = getBrokerLaunchSpec(
			"C:\\lunr\\broker.js",
			"npx",
			["--no-install", "tsx"],
			"C:\\lunr",
			"win32",
			"C:\\intercom",
			"C:\\nodejs\\node.exe",
			"C:\\intercom\\broker.stderr.log",
		);
		expect(windows.kind).toBe("windows-launcher");
		if (windows.kind !== "windows-launcher") return;
		expect(windows.command).toBe("wscript.exe");
		expect(windows.launcherCommandLine).toContain("C:\\nodejs\\node.exe");
		expect(windows.launcherCommandLine).toContain("C:\\lunr\\broker.js");
		expect(windows.launcherCommandLine).not.toContain("tsx");
		expect(windows.launcherCommandLine).toContain("broker.stderr.log");
	});

	it("uses tsx and broker.ts when the TypeScript source is what exists", () => {
		const linux = getBrokerLaunchSpec(
			"/opt/lunr/broker.ts",
			"npx",
			["--no-install", "tsx"],
			"/opt/lunr",
			"linux",
			"/tmp/intercom",
			"/usr/bin/node",
		);
		expect(linux.kind).toBe("direct");
		if (linux.kind !== "direct") return;
		expect(linux.command).toBe("/usr/bin/node");
		expect(linux.args.at(-1)).toBe("/opt/lunr/broker.ts");
		expect(linux.args.some((arg) => arg.includes("tsx") || arg.endsWith("cli.mjs"))).toBe(true);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-broker-src-"));
		try {
			fs.writeFileSync(path.join(dir, "broker.ts"), "export {}\n");
			expect(resolveBrokerScriptPath(dir)).toBe(path.join(dir, "broker.ts"));
			fs.unlinkSync(path.join(dir, "broker.ts"));
			fs.writeFileSync(path.join(dir, "broker.js"), "export {}\n");
			expect(resolveBrokerScriptPath(dir)).toBe(path.join(dir, "broker.js"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("native supervisor channel", () => {
	it("does not spawn the broker for contact_supervisor when supervisor env is set", async () => {
		process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR = path.join(os.tmpdir(), "lunr-supervisor-channel");
		process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = "parent";
		process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = "parent-session";
		process.env.PI_SUBAGENT_RUN_ID = "run-native";
		process.env.PI_SUBAGENT_CHILD_AGENT = "child";
		process.env.PI_SUBAGENT_CHILD_INDEX = "0";
		expect(isNativeSupervisorChannelActive()).toBe(true);
		const started = Date.now();
		await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
		expect(Date.now() - started).toBeLessThan(1000);

		const brokerPi = fakePi();
		piIntercomExtension(brokerPi as never);
		expect(brokerPi.tools.has("contact_supervisor")).toBe(false);

		const nativePi = fakePi();
		registerNativeSupervisorClient(nativePi as never);
		expect(nativePi.tools.has("contact_supervisor")).toBe(true);
	});

	it("surfaces async need_decision as pending attention and unblocks on reply", async () => {
		const sessionId = `sess-${Date.now()}`;
		const runId = `attn-${Date.now()}`;
		const agent = "Continue native computer use";
		const channelDir = resolveSupervisorChannelDir(runId, agent, 0);
		const asyncRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-async-attn-"));
		const resultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lunr-async-attn-results-"));
		const runDir = path.join(asyncRoot, runId);
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "status.json"),
			JSON.stringify({
				runId,
				sessionId,
				mode: "single",
				state: "running",
				pid: 1234,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [
					{
						childId: `${runId}-0`,
						description: agent,
						permissions: "full",
						agent,
						status: "running",
					},
				],
			}),
		);

		process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR = channelDir;
		process.env.PI_SUBAGENT_RUN_ID = runId;
		process.env.PI_SUBAGENT_CHILD_AGENT = agent;
		process.env.PI_SUBAGENT_CHILD_INDEX = "0";
		process.env.PI_SUBAGENT_ORCHESTRATOR_TARGET = "parent";
		process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID = sessionId;
		process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "5000";

		const pi = fakePi();
		const state = {
			currentSessionId: sessionId,
			asyncJobs: new Map(),
			foregroundControls: new Map(),
			foregroundRuns: new Map(),
			lastUiContext: {
				sessionManager: { getSessionId: () => sessionId },
			},
		} as unknown as SubagentState;
		const channel = createNativeSupervisorChannel(pi as never, state);
		registerNativeSupervisorClient(pi as never, { includeIntercomFallback: false });
		channel.start();

		const childTool = pi.tools.get("contact_supervisor");
		expect(childTool).toBeDefined();
		const childPending = childTool!.execute(
			"call-1" as never,
			{ reason: "need_decision", message: "Should I continue the native computer-use branch?" } as never,
			undefined as never,
		) as Promise<{ content: Array<{ text: string }> }>;

		const started = Date.now();
		while (!hasPendingBlockingSupervisorRequest(runId, sessionId) && Date.now() - started < 2000) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(hasPendingBlockingSupervisorRequest(runId, sessionId)).toBe(true);

		const waitResult = await waitForSubagents({ id: runId, timeoutMs: 2000 }, undefined, {
			state,
			asyncDirRoot: asyncRoot,
			resultsDir: resultsRoot,
			kill: () => true,
			pollIntervalMs: 250,
			sleep: async () => {},
		});
		expect(waitResult.content[0]?.text ?? "").toMatch(/need attention|attention required/);

		const pollStarted = Date.now();
		const parentTool = pi.tools.get(NATIVE_SUPERVISOR_TOOL_NAME);
		expect(parentTool).toBeDefined();
		let pendingText = "";
		while (Date.now() - pollStarted < 2000) {
			const pending = (await parentTool!.execute("pending" as never, { action: "pending" } as never)) as {
				content: Array<{ text: string }>;
				details?: { pending?: unknown[] };
			};
			pendingText = pending.content[0]?.text ?? "";
			if (pending.details?.pending && pending.details.pending.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(pendingText).not.toBe("No pending supervisor requests.");

		const pending = (await parentTool!.execute("pending" as never, { action: "pending" } as never)) as {
			details?: { pending?: Array<{ id: string }> };
		};
		const requestId = pending.details?.pending?.[0]?.id;
		expect(requestId).toBeTruthy();
		await parentTool!.execute(
			"reply" as never,
			{ action: "reply", replyTo: requestId, message: "Yes, continue." } as never,
		);
		const childResult = await childPending;
		expect(childResult.content[0]?.text).toContain("Yes, continue.");

		channel.dispose();
		fs.rmSync(asyncRoot, { recursive: true, force: true });
		fs.rmSync(resultsRoot, { recursive: true, force: true });
		fs.rmSync(channelDir, { recursive: true, force: true });
	});
});
