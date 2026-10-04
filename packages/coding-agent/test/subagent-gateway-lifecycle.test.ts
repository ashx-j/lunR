import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const isolated = await vi.hoisted(async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const root = fs.mkdtempSync(`${os.tmpdir()}/lunr-subagent-gateway-`);
	const env = { ...process.env };
	for (const key of Object.keys(process.env)) {
		if (/^PI_(SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD/.test(key))
			delete process.env[key];
	}
	process.env.PI_CODING_AGENT_DIR = `${root}/profile`;
	process.env.TMPDIR = root;
	process.env.PI_OFFLINE = "1";
	fs.mkdirSync(`${root}/profile`, { recursive: true });
	fs.mkdirSync(`${root}/project`);
	return {
		root,
		env,
		apis: [] as ExtensionAPI[],
		watchers: [] as Array<{
			close: ReturnType<typeof vi.fn>;
			error: (error: Error) => void;
			notify: (event: string, file: string) => void;
		}>,
		factoryWatchCounts: [] as number[],
	};
});

// The gateway's default factory still creates real services, loader, runtime,
// session and extension runner. Select the assigned built-in; no provider turn,
// broker, browser or other unrelated built-in needs to start in this fixture.
vi.mock("../src/builtin-extensions/index.ts", () => ({
	loadAllBuiltinExtensions: async () => {
		const { default: register } = await import("../src/builtin-extensions/pi-subagents/index.ts");
		return [
			{
				name: "pi-subagents",
				factory: (pi: ExtensionAPI) => {
					isolated.apis.push(pi);
					register(pi);
					isolated.factoryWatchCounts.push(isolated.watchers.length);
				},
			},
		];
	},
}));
vi.mock("../src/gateway/presenter.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/gateway/presenter.ts")>()),
	withGatewayPresentation: (_key: string, run: () => Promise<unknown>) => run(),
	sendGatewayNotice: vi.fn(async () => {}),
}));
vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	watch: (_path: unknown, notify: (event: string, file: string) => void) => {
		const close = vi.fn();
		const watcher = Object.assign(new EventEmitter(), { close, unref() {} });
		isolated.watchers.push({
			close,
			notify,
			error: (error) => {
				watcher.emit("error", error);
			},
		});
		return watcher;
	},
}));

import { resolveSupervisorChannelDir } from "../src/builtin-extensions/pi-subagents/src/intercom/supervisor-questions.ts";
import {
	RESULTS_DIR,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_CONTROL_EVENT,
} from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import { getSubagentCancellation } from "../src/core/subagent-cancellation.ts";
import { AgentBridge } from "../src/gateway/agent-bridge.ts";
import { bindConversation } from "../src/gateway/conversations.ts";

let bridge: AgentBridge | undefined;
afterEach(async () => {
	await bridge?.shutdown();
	bridge = undefined;
	vi.useRealTimers();
	vi.restoreAllMocks();
});
afterAll(() => {
	for (const key of Object.keys(process.env)) if (!(key in isolated.env)) delete process.env[key];
	Object.assign(process.env, isolated.env);
	rmSync(isolated.root, { recursive: true, force: true });
});

function bind(key: string) {
	bindConversation(
		key,
		{ platform: "telegram", chatId: key, chatType: "dm", userId: "test-user" },
		{ cwd: join(isolated.root, "project") },
	);
}
function completions(session: AgentSession) {
	return session.messages.filter((message) => message.role === "custom" && message.customType === "subagent-notify");
}

describe("built-in subagents in gateway session factories", () => {
	it("retains both owners' watcher, cancellation and supervisor delivery as either closes", async () => {
		vi.useFakeTimers();
		bind("gateway-a");
		bind("gateway-b");
		bridge = new AgentBridge();
		const a = (await bridge.getSession("gateway-a", true)) as AgentSession;
		const apiA = isolated.apis[0]!;
		const watcherA = isolated.watchers[0]!;
		const aId = a.sessionManager.getSessionId();
		const aOwner = a.sessionManager.getSessionFile()!;
		expect(process.env.PI_SUBAGENT_PARENT_SESSION).toBeUndefined();
		expect(isolated.factoryWatchCounts).toEqual([0]);
		expect(getSubagentCancellation(aId)).toBeDefined();
		const b = (await bridge.getSession("gateway-b", true)) as AgentSession;
		const apiB = isolated.apis[1]!;
		const bId = b.sessionManager.getSessionId();
		const bOwner = b.sessionManager.getSessionFile()!;
		expect(isolated.factoryWatchCounts).toEqual([0, 1]);
		expect(watcherA.close).not.toHaveBeenCalled();
		expect(getSubagentCancellation(aId)).toBeDefined();
		expect(getSubagentCancellation(bId)).toBeDefined();

		apiA.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: "owned-run-a",
			sessionId: aOwner,
			asyncDir: join(isolated.root, "run-a"),
			agent: "child-a",
		});
		expect(getSubagentCancellation(aId)?.hasActiveRuns()).toBe(true);
		const channel = resolveSupervisorChannelDir("owned-run-a", "child-a", 0);
		mkdirSync(join(channel, "requests"), { recursive: true });
		writeFileSync(
			join(channel, "requests", "decision-a.json"),
			JSON.stringify({
				type: "subagent.supervisor.request",
				id: "decision-a",
				createdAt: Date.now(),
				reason: "need_decision",
				message: "Which scratch file should I read?",
				expectsReply: true,
				runId: "owned-run-a",
				agent: "child-a",
				childIndex: 0,
				orchestratorSessionId: aId,
			}),
		);
		await vi.advanceTimersByTimeAsync(500);
		expect(
			a.messages.some(
				(message) =>
					message.role === "custom" &&
					typeof message.content === "string" &&
					message.content.includes("Which scratch"),
			),
		).toBe(true);
		expect(b.messages).toHaveLength(0);
		const supervisor = a.getToolDefinition("subagent_supervisor")!;
		await supervisor.execute(
			"reply",
			{ action: "reply", replyTo: "decision-a", message: "Read a.txt" },
			new AbortController().signal,
			undefined,
			a.extensionRunner!.createContext(),
		);
		expect(JSON.parse(readFileSync(join(channel, "replies", "decision-a.json"), "utf8"))).toMatchObject({
			message: "Read a.txt",
		});

		// Drive the actual result watcher on A after B's factory has run.
		writeFileSync(
			join(RESULTS_DIR, "gateway-result-a.json"),
			JSON.stringify({
				id: "owned-run-a",
				sessionId: aOwner,
				state: "complete",
				success: true,
				summary: "A finished",
			}),
		);
		watcherA.notify("rename", "gateway-result-a.json");
		apiB.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "result-b",
			sessionId: bOwner,
			state: "complete",
			success: true,
			summary: "B finished",
		});
		await vi.advanceTimersByTimeAsync(300);
		expect(completions(a)).toHaveLength(1);
		expect(completions(b)).toHaveLength(1);
		expect(getSubagentCancellation(aId)?.hasActiveRuns()).toBe(false);

		// Reload A through the real lifecycle without replacing B. Its already
		// delivered completion stays deduplicated by the owner identity.
		const controlNotice = {
			source: "async",
			event: {
				type: "needs_attention",
				reason: "completion_guard",
				runId: "owned-run-a",
				agent: "child-a",
				ts: Date.now(),
			},
		};
		apiA.events.emit(SUBAGENT_CONTROL_EVENT, controlNotice);
		const notices = () =>
			a.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "subagent_control_notice");
		expect(notices()).toHaveLength(1);
		const watcherB = isolated.watchers[1]!;
		await a.reload();
		const reloadedWatcherA = isolated.watchers[2]!;
		const reloadedApiA = isolated.apis[2]!;
		expect(watcherA.close).toHaveBeenCalledOnce();
		expect(watcherB.close).not.toHaveBeenCalled();
		watcherA.error(new Error("late error from disposed watcher"));
		watcherA.notify("rename", "gateway-result-a.json");
		expect(getSubagentCancellation(aId)).toBeDefined();
		expect(getSubagentCancellation(bId)).toBeDefined();
		reloadedApiA.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "owned-run-a",
			sessionId: aOwner,
			state: "complete",
			success: true,
			summary: "A finished",
		});
		reloadedApiA.events.emit(SUBAGENT_CONTROL_EVENT, controlNotice);
		await vi.advanceTimersByTimeAsync(150);
		expect(notices()).toHaveLength(1);
		expect(completions(a)).toHaveLength(1);

		// Pending B completion must disappear before its real runtime invalidates.
		apiB.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "pending-b",
			sessionId: bOwner,
			state: "complete",
			success: true,
			summary: "Pending",
		});
		process.env.PI_SUBAGENT_PARENT_SESSION = "external-owner";
		await bridge.reset("gateway-b");
		expect(process.env.PI_SUBAGENT_PARENT_SESSION).toBe("external-owner");
		expect(getSubagentCancellation(bId)).toBeUndefined();
		expect(getSubagentCancellation(aId)).toBeDefined();
		expect(reloadedWatcherA.close).not.toHaveBeenCalled();
		reloadedApiA.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "after-b-close",
			sessionId: aOwner,
			state: "complete",
			success: true,
			summary: "Still alive",
		});
		await vi.advanceTimersByTimeAsync(2000);
		expect(completions(a)).toHaveLength(2);
		expect(completions(b)).toHaveLength(1);
		expect(isolated.watchers).toHaveLength(3);
		await bridge.reset("gateway-a");
		expect(reloadedWatcherA.close).toHaveBeenCalledOnce();
		expect(getSubagentCancellation(aId)).toBeUndefined();
	});
});
