import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	ClientSideConnection,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const providerPath = fileURLToPath(new URL("fixtures/acp-provider.ts", import.meta.url));
const lifecyclePath = fileURLToPath(new URL("fixtures/acp-lifecycle.ts", import.meta.url));
const mcpPath = fileURLToPath(new URL("fixtures/acp-mcp-server.mjs", import.meta.url));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mT0AAAAASUVORK5CYII=";

type Fixture = Awaited<ReturnType<typeof launch>>;
const fixtures: Fixture[] = [];

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pids(path: string): number[] {
	return existsSync(path)
		? [...new Set(readFileSync(path, "utf8").trim().split("\n").map(Number).filter(Number.isSafeInteger))]
		: [];
}

function assistantText(updates: SessionNotification[], start = 0): string {
	return updates
		.slice(start)
		.flatMap(({ update }) =>
			update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : [],
		)
		.join("");
}

async function launch(options: { lifecycle?: boolean; startupDialog?: boolean; profile?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "lunr-acp-integration-"));
	const home = join(directory, "home");
	const agentDir = join(home, ".lunr", "agent");
	const project = join(directory, "project");
	const temporary = join(directory, "tmp");
	for (const path of [agentDir, project, temporary]) mkdirSync(path, { recursive: true });
	mkdirSync(join(agentDir, "extensions"));
	copyFileSync(providerPath, join(agentDir, "extensions", "acp-provider.ts"));
	if (options.lifecycle) copyFileSync(lifecyclePath, join(agentDir, "extensions", "acp-lifecycle.ts"));
	const settingsPath = join(agentDir, "settings.json");
	const settings = `${JSON.stringify({ ...(options.profile ? { browserEnabled: true, automaticSubagentDelegation: true, defaultPermissionMode: "auto" } : {}), computerUse: false, defaultProvider: "acp-fixture", defaultModel: "test", defaultThinkingLevel: "medium", compaction: { enabled: false }, retry: { enabled: false } }, null, 2)}\n`;
	writeFileSync(settingsPath, settings);
	const subagentConfig = join(agentDir, "extensions", "subagent", "config.json");
	if (options.profile) {
		mkdirSync(join(agentDir, "extensions", "subagent"));
		writeFileSync(subagentConfig, '{"scheduledRuns":{"enabled":true}}');
	}
	const sentinel = join(directory, "daily-driver-settings.json");
	writeFileSync(sentinel, "daily-driver sentinel\n");
	const workerPids = join(directory, "worker-pids");
	const mcpPids = join(directory, "mcp-pids");
	const environment: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		USERPROFILE: home,
		APPDATA: join(home, "appdata"),
		LOCALAPPDATA: join(home, "localappdata"),
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir,
		ACP_FIXTURE_WORKER_PIDS: workerPids,
		ACP_FIXTURE_MCP_PIDS: mcpPids,
		...(options.startupDialog ? { ACP_FIXTURE_STARTUP_DIALOG: "1" } : {}),
		NO_COLOR: "1",
	};
	const child: ChildProcessWithoutNullStreams = spawn(
		process.execPath,
		[cliPath, "--mode", "acp", "--offline", "--provider", "acp-fixture", "--model", "test"],
		{ cwd: project, env: environment, stdio: "pipe" },
	);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	const updates: SessionNotification[] = [];
	const permissions: RequestPermissionRequest[] = [];
	let permissionDecision: "allow" | "reject" | "hold" = "allow";
	const heldPermissions: Array<(response: RequestPermissionResponse) => void> = [];
	const forms: CreateElicitationRequest[] = [];
	const heldForms: Array<(response: CreateElicitationResponse) => void> = [];
	const connection = new ClientSideConnection(
		() => ({
			async sessionUpdate(notification) {
				updates.push(notification);
			},
			async requestPermission(request) {
				permissions.push(request);
				if (permissionDecision === "hold")
					return new Promise<RequestPermissionResponse>((resolve) => heldPermissions.push(resolve));
				const option = request.options.find(
					(entry) => entry.kind === (permissionDecision === "allow" ? "allow_once" : "reject_once"),
				);
				if (!option) throw new Error("Missing fixture permission option.");
				return { outcome: { outcome: "selected", optionId: option.optionId } };
			},
			async unstable_createElicitation(request) {
				forms.push(request);
				return new Promise<CreateElicitationResponse>((resolve) => heldForms.push(resolve));
			},
		}),
		ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
	);
	let ended = false;
	const fixture = {
		directory,
		agentDir,
		project,
		subagentConfig,
		settingsPath,
		settings,
		sentinel,
		workerPids,
		mcpPids,
		child,
		connection,
		updates,
		permissions,
		forms,
		answerForm(answer: string) {
			heldForms.shift()?.({ action: "accept", content: { answer } });
		},
		dismissForm() {
			heldForms.shift()?.({ action: "cancel" });
		},
		answerPermission() {
			heldPermissions.shift()?.({ outcome: { outcome: "selected", optionId: "allow" } });
		},
		setPermissionDecision(decision: typeof permissionDecision) {
			permissionDecision = decision;
		},
		get stderr() {
			return stderr;
		},
		async finish() {
			if (ended) return;
			ended = true;
			for (const resolve of heldPermissions) resolve({ outcome: { outcome: "cancelled" } });
			for (const resolve of heldForms) resolve({ action: "cancel" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			child.stdin.end();
			const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
			try {
				const result = await closed;
				if (result.code !== 0) throw new Error(`ACP exited ${result.signal ?? result.code}: ${stderr}`);
			} finally {
				clearTimeout(timeout);
			}
		},
	};
	fixtures.push(fixture);
	return fixture;
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		try {
			await fixture.finish();
		} finally {
			// Windows can retain worker file handles briefly after the close event.
			await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

describe("compiled ACP stdio integration", () => {
	it("applies the ACP profile across reload and resume without changing saved preferences", async () => {
		const fixture = await launch({ profile: true });
		const { connection, project, updates } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const created = await connection.newSession({ cwd: project, mcpServers: [] });
		const { sessionId } = created;
		expect(created.modes?.currentModeId).toBe("yolo");
		const profile = async () => {
			const start = updates.length;
			await connection.prompt({ sessionId, prompt: [{ type: "text", text: "profile" }] });
			const result: unknown = JSON.parse(assistantText(updates, start));
			return result;
		};
		const initial = await profile();
		expect(initial).toMatchInlineSnapshot(`
			{
			  "automaticDelegation": false,
			  "clientScheduling": true,
			  "cronGuidance": false,
			  "directWork": true,
			  "schedulesAdvertised": false,
			  "subagentParameters": [
			    "acceptance",
			    "action",
			    "artifacts",
			    "async",
			    "chain",
			    "chainDir",
			    "clarify",
			    "concurrency",
			    "context",
			    "control",
			    "cwd",
			    "description",
			    "dir",
			    "id",
			    "includeProgress",
			    "index",
			    "lines",
			    "maxRuntimeMs",
			    "message",
			    "model",
			    "output",
			    "outputMode",
			    "permissions",
			    "runId",
			    "sessionDir",
			    "share",
			    "skill",
			    "task",
			    "tasks",
			    "thinking",
			    "tier",
			    "timeoutMs",
			    "toolBudget",
			    "turnBudget",
			    "view",
			    "worktree",
			  ],
			  "tools": [
			    "ast_search",
			    "bash",
			    "code_overview",
			    "code_rewrite",
			    "edit",
			    "fetch_content",
			    "get_search_content",
			    "intercom",
			    "lsp_code_actions",
			    "lsp_completions",
			    "lsp_definition",
			    "lsp_diagnostics",
			    "lsp_hover",
			    "lsp_references",
			    "lsp_rename",
			    "lsp_symbols",
			    "mcp",
			    "memory_add",
			    "memory_load",
			    "memory_remove",
			    "pr_watch",
			    "present_plan",
			    "read",
			    "subagent",
			    "subagent_supervisor",
			    "subagent_wait",
			    "todo",
			    "web_search",
			    "write",
			  ],
			}
		`);
		expect(initial).toMatchObject({
			schedulesAdvertised: false,
			clientScheduling: true,
			automaticDelegation: false,
			directWork: true,
			cronGuidance: false,
		});
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "schedule" }] });
		expect(assistantText(updates)).toContain(
			"Scheduled subagents are disabled in ACP sessions. Use the client's scheduler.",
		);
		await connection.setSessionMode({ sessionId, modeId: "read-only" });
		await connection.setSessionConfigOption({ sessionId, configId: "thought_level", value: "high" });
		await connection.setSessionConfigOption({ sessionId, configId: "model", value: "acp-fixture/text-only" });
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/fixture-reload" }] });
		expect(await profile()).toEqual(initial);
		await connection.closeSession({ sessionId });
		const restored = await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		expect(restored.modes?.currentModeId).toBe("read-only");
		expect(await profile()).toEqual(initial);
		await fixture.finish();
		expect(readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.settings);
		expect(readFileSync(fixture.subagentConfig, "utf8")).toBe('{"scheduledRuns":{"enabled":true}}');
	}, 30_000);

	it("keeps extension status notifications separate from streamed assistant text", async () => {
		const fixture = await launch({ lifecycle: true });
		const { connection, project, updates } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });
		expect(assistantText(updates)).toBe("fixture response model=test reasoning=medium images=0");
		expect(updates).toContainEqual({
			sessionId,
			update: expect.objectContaining({
				sessionUpdate: "tool_call",
				title: "lunR notification",
				kind: "other",
				status: "completed",
				content: [{ type: "content", content: { type: "text", text: "MCP: 1 servers connected (83 tools)" } }],
			}),
		});
		await fixture.finish();
	}, 90_000);

	it("declines startup dialogs before opening a usable session", async () => {
		const fixture = await launch({ lifecycle: true, startupDialog: true });
		const { connection, project, forms } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		expect(JSON.parse(readFileSync(join(project, "startup-results.json"), "utf8"))).toEqual([
			null,
			false,
			null,
			null,
		]);
		expect(forms).toHaveLength(0);
		expect(fixture.stderr).toContain("skipped startup question");
		expect((await connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] })).stopReason).toBe(
			"end_turn",
		);
	}, 30_000);

	it("stops a worker after malformed output before reporting failure", async () => {
		const fixture = await launch({ lifecycle: true });
		const { connection, project, updates } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		await expect(
			connection.prompt({ sessionId, prompt: [{ type: "text", text: "/fixture-protocol-failure" }] }),
		).rejects.toThrow();
		expect(pids(fixture.workerPids).length).toBeGreaterThan(0);
		expect(pids(fixture.workerPids).every((pid) => !alive(pid))).toBe(true);
		expect(existsSync(join(project, "after-failure"))).toBe(false);
		expect(assistantText(updates)).not.toContain("work continued after failure");
		// a failed worker does not damage the adapter's next session.
		const next = await connection.newSession({ cwd: project, mcpServers: [] });
		expect(
			(await connection.prompt({ sessionId: next.sessionId, prompt: [{ type: "text", text: "report" }] }))
				.stopReason,
		).toBe("end_turn");
	}, 30_000);

	it.each([
		{ kind: "timed", action: "dismiss" },
		{ kind: "aborted", action: "answer" },
		{ kind: "timed", action: "stop" },
	] as const)(
		"keeps a $kind form inside its turn until the client chooses $action",
		async ({ kind, action }) => {
			const fixture = await launch({ lifecycle: true });
			const { connection, project, forms, updates } = fixture;
			await connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
			const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
			let finished = false;
			const prompt = connection
				.prompt({ sessionId, prompt: [{ type: "text", text: `/fixture-${kind}-form` }] })
				.finally(() => {
					finished = true;
				});
			await vi.waitFor(() => expect(forms).toHaveLength(1));
			await vi.waitFor(() => expect(assistantText(updates)).toContain("Dismiss it or stop the turn"));
			expect(readFileSync(join(project, `${kind}-answer`), "utf8")).toBe("cancelled");
			expect(finished).toBe(false);
			await expect(connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] })).rejects.toThrow();
			if (action === "stop") {
				await connection.cancel({ sessionId });
				fixture.dismissForm();
			} else if (action === "dismiss") fixture.dismissForm();
			else fixture.answerForm("late answer");
			expect((await prompt).stopReason).toBe(action === "stop" ? "cancelled" : "end_turn");
			expect(readFileSync(join(project, `${kind}-answer`), "utf8")).toBe("cancelled");
			expect((await connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] })).stopReason).toBe(
				"end_turn",
			);
		},
		30_000,
	);

	it("does not revive an internally aborted plan approval when the client answers late", async () => {
		const fixture = await launch({ lifecycle: true });
		const { connection, project, updates, permissions } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		await connection.setSessionMode({ sessionId, modeId: "read-only" });
		fixture.setPermissionDecision("hold");
		let finished = false;
		const prompt = connection.prompt({ sessionId, prompt: [{ type: "text", text: "plan" }] }).finally(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(permissions).toHaveLength(1));
		writeFileSync(join(project, "abort-approval"), "abort this plan");
		await vi.waitFor(() => expect(assistantText(updates)).toContain("Dismiss it or stop the turn"));
		expect(finished).toBe(false);
		fixture.answerPermission();
		await prompt;
		expect(existsSync(join(project, "planned.txt"))).toBe(false);
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === permissions[0].toolCall.toolCallId &&
					update.status === "failed",
			),
		).toBe(true);
		await connection.closeSession({ sessionId });
		const restored = await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		expect(restored.modes?.currentModeId).toBe("read-only");
	}, 30_000);

	it("streams, approves tools, scopes configuration and reloads native session history", async () => {
		const fixture = await launch();
		const { connection, project, updates, permissions } = fixture;
		const initialized = await connection.initialize({ protocolVersion: 2, clientCapabilities: {} });
		expect(initialized).toMatchObject({
			protocolVersion: 1,
			agentInfo: { name: "lunr" },
			agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
		});
		const created = await connection.newSession({ cwd: project, mcpServers: [] });
		const sessionId = created.sessionId;
		expect(created.configOptions?.find((option) => option.id === "model")?.currentValue).toBe("acp-fixture/test");
		await connection.closeSession({ sessionId });
		await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		const response = await connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] });
		expect(response.stopReason).toBe("end_turn");
		expect(assistantText(updates)).toContain("fixture response model=test reasoning=medium images=0");
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "agent_thought_chunk" &&
					update.content.type === "text" &&
					update.content.text === "fixture reasoning",
			),
		).toBe(true);
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "write allowed.txt" }] });
		expect(readFileSync(join(project, "allowed.txt"), "utf8")).toBe("written by fixture\n");
		expect(permissions.at(-1)?.toolCall.title).toBe("write");
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "tool_call_update" &&
					update.content?.some(
						(content) =>
							content.type === "diff" &&
							content.path === join(project, "allowed.txt") &&
							content.newText === "written by fixture\n",
					),
			),
		).toBe(true);
		fixture.setPermissionDecision("reject");
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "write denied.txt" }] });
		expect(existsSync(join(project, "denied.txt"))).toBe(false);
		expect(assistantText(updates)).toContain("Tool execution denied by ACP client.");
		await connection.setSessionConfigOption({ sessionId, configId: "thought_level", value: "high" });
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] });
		expect(assistantText(updates)).toContain("reasoning=high");
		await connection.setSessionMode({ sessionId, modeId: "read-only" });
		const permissionCount = permissions.length;
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "write readonly.txt" }] });
		expect(existsSync(join(project, "readonly.txt"))).toBe(false);
		expect(permissions).toHaveLength(permissionCount);
		fixture.setPermissionDecision("allow");
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "plan" }] });
		expect(readFileSync(join(project, "planned.txt"), "utf8")).toBe("plan approved\n");
		const planApproval = permissions.find(
			(request) =>
				request.toolCall.rawInput &&
				typeof request.toolCall.rawInput === "object" &&
				"kind" in request.toolCall.rawInput &&
				request.toolCall.rawInput.kind === "plan",
		);
		expect(planApproval).toBeDefined();
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "tool_call_update" &&
					update.toolCallId === planApproval?.toolCall.toolCallId &&
					update.status === "completed",
			),
		).toBe(true);
		await connection.setSessionMode({ sessionId, modeId: "read-only" });
		await connection.setSessionConfigOption({ sessionId, configId: "model", value: "acp-fixture/text-only" });
		await expect(
			connection.prompt({ sessionId, prompt: [{ type: "image", mimeType: "image/png", data: png }] }),
		).rejects.toThrow("does not support images");
		await connection.setSessionConfigOption({ sessionId, configId: "model", value: "acp-fixture/test" });
		await connection.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "report" },
				{ type: "image", mimeType: "image/png", data: png },
			],
		});
		expect(assistantText(updates)).toContain("images=1");
		await connection.setSessionConfigOption({ sessionId, configId: "model", value: "acp-fixture/text-only" });
		await connection.closeSession({ sessionId });
		const replayStart = updates.length;
		const restored = await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		expect(restored.modes?.currentModeId).toBe("read-only");
		expect(restored.configOptions?.find((option) => option.id === "model")?.currentValue).toBe(
			"acp-fixture/text-only",
		);
		expect(assistantText(updates, replayStart)).toContain("fixture response");
		expect(updates.slice(replayStart).some(({ update }) => update.sessionUpdate === "user_message_chunk")).toBe(true);
		expect(readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.settings);
		expect(readFileSync(fixture.sentinel, "utf8")).toBe("daily-driver sentinel\n");
		await fixture.finish();
		await vi.waitFor(() => expect(pids(fixture.workerPids).every((pid) => !alive(pid))).toBe(true), {
			timeout: 10_000,
		});
	}, 90_000);

	it("connects an injected MCP server and cancels pending approval before EOF cleanup", async () => {
		const fixture = await launch();
		const { connection, updates, permissions, project } = fixture;
		await connection.initialize({ protocolVersion: 2, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({
			cwd: project,
			mcpServers: [
				{
					name: "host",
					command: process.execPath,
					args: [mcpPath],
					env: [
						{ name: "ACP_FIXTURE_MCP_MARKER", value: "host MCP environment marker" },
						{ name: "ACP_FIXTURE_MCP_PIDS", value: fixture.mcpPids },
					],
				},
			],
		});
		await connection.setSessionMode({ sessionId, modeId: "auto" });
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "mcp" }] });
		expect(assistantText(updates)).toContain("host MCP environment marker");
		expect(permissions.some((request) => request.toolCall.title === "mcp")).toBe(true);
		expect(pids(fixture.mcpPids).length).toBeGreaterThan(0);
		fixture.setPermissionDecision("hold");
		const count = permissions.length;
		const pendingPrompt = connection.prompt({ sessionId, prompt: [{ type: "text", text: "write cancelled.txt" }] });
		await vi.waitFor(() => expect(permissions.length).toBeGreaterThan(count), { timeout: 15_000 });
		await expect(connection.setSessionMode({ sessionId, modeId: "auto" })).rejects.toThrow();
		await connection.cancel({ sessionId });
		expect((await pendingPrompt).stopReason).toBe("cancelled");
		expect(existsSync(join(project, "cancelled.txt"))).toBe(false);
		await fixture.finish();
		await vi.waitFor(
			() => {
				expect(pids(fixture.workerPids).every((pid) => !alive(pid))).toBe(true);
				expect(pids(fixture.mcpPids).every((pid) => !alive(pid))).toBe(true);
			},
			{ timeout: 10_000 },
		);
		expect(readFileSync(fixture.settingsPath, "utf8")).toBe(fixture.settings);
		expect(existsSync(join(fixture.agentDir, "mcp-cache.json"))).toBe(false);
	}, 90_000);

	it("keeps a delayed form inside its turn, reports slash output and preserves client-owned identity", async () => {
		const fixture = await launch();
		const { connection, project, updates, forms } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		const prompt = connection.prompt({ sessionId, prompt: [{ type: "text", text: "/fixture-ask" }] });
		let settled = false;
		void prompt.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await vi.waitFor(() => expect(forms).toHaveLength(1));
		// user dialogs can outlive the worker's ordinary 30-second command timeout.
		await new Promise((resolve) => setTimeout(resolve, 31_000));
		expect(settled).toBe(false);
		await expect(connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] })).rejects.toThrow();
		fixture.answerForm("supplied by client");
		expect((await prompt).stopReason).toBe("end_turn");
		expect(assistantText(updates)).toContain("fixture answer: supplied by client");
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/fixture-note" }] });
		expect(assistantText(updates)).toContain("fixture final child report");
		expect(assistantText(updates)).not.toContain("hidden journal context");
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/high" }] });
		expect(
			updates.some(
				({ update }) =>
					update.sessionUpdate === "config_option_update" &&
					update.configOptions.some((option) => option.id === "thought_level" && option.currentValue === "high"),
			),
		).toBe(true);
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/fixture-new" }] });
		expect(assistantText(updates)).toContain("ACP client owns session selection");
		await connection.prompt({ sessionId, prompt: [{ type: "text", text: "report" }] });
		await connection.closeSession({ sessionId });
		const restored = await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		expect(restored.configOptions?.find((option) => option.id === "thought_level")?.currentValue).toBe("high");
	}, 90_000);

	it("keeps native async child completion and the parent follow-up inside the ACP turn", async () => {
		const fixture = await launch();
		const { connection, project, updates } = fixture;
		await connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await connection.newSession({ cwd: project, mcpServers: [] });
		expect((await connection.prompt({ sessionId, prompt: [{ type: "text", text: "delegate" }] })).stopReason).toBe(
			"end_turn",
		);
		expect(assistantText(updates)).toContain("fixture response model=test reasoning=medium images=0");
		expect(assistantText(updates)).not.toContain("Background task completed:");
		const notice = updates.find(
			({ update }) => update.sessionUpdate === "tool_call" && update.title === "lunR subagent notification",
		);
		expect(notice?.update).toMatchObject({ status: "completed", kind: "other" });
		expect(JSON.stringify(notice?.update)).toContain("native child completed");
		await connection.closeSession({ sessionId });
		const replayStart = updates.length;
		await connection.loadSession({ sessionId, cwd: project, mcpServers: [] });
		expect(assistantText(updates, replayStart)).not.toContain("Background task completed:");
		expect(updates.slice(replayStart)).toContainEqual(notice);
		expect(pids(fixture.workerPids).length).toBeGreaterThan(1);
		await fixture.finish();
		await vi.waitFor(() => expect(pids(fixture.workerPids).every((pid) => !alive(pid))).toBe(true), {
			timeout: 10_000,
		});
	}, 90_000);
});
