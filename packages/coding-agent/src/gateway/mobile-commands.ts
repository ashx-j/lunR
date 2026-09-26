import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getPermissionMode, PERMISSION_MODES, setPermissionMode } from "../core/permissions.ts";
import { SessionManager } from "../core/session-manager.ts";
import { getSubagentCancellation } from "../core/subagent-cancellation.ts";
import { isGatewayOwner, requireGatewayOwner } from "./authz.ts";
import { createPicker, type PickerItem, type PickerResolveResult } from "./buttons.ts";
import { type GatewayConfig, loadGatewayConfig } from "./config.ts";
import { bindConversation, conversationBinding } from "./conversations.ts";
import { gatewayInput, gatewaySelect } from "./presenter.ts";
import type { BridgeLike } from "./router.ts";
import type { MessageEvent, PlatformAdapter } from "./types.ts";

export const MOBILE_COMMANDS = [
	{ name: "project", description: "Browse folders and choose a project" },
	{ name: "continue", description: "Continue a handoff or the latest TUI session" },
	{ name: "sessions", description: "Browse saved sessions across projects" },
	{ name: "mode", description: "Choose yolo, auto, or read-only permissions" },
	{ name: "plan", description: "Plan work and approve it from this chat" },
	{ name: "settings", description: "Change this session's model, thinking, or permissions" },
	{ name: "stopall", description: "Stop this session and its background subagents" },
	{ name: "download", description: "Send a file from the current project" },
	{ name: "usage", description: "Show session tokens and subscription usage" },
	{ name: "processes", description: "List or stop this session's shell processes" },
	{ name: "refresh", description: "Refresh available models" },
	{ name: "skill", description: "Choose a skill and send it a task" },
	{ name: "fast", description: "Toggle OpenAI Codex fast mode" },
];

export const FORWARDED_COMMANDS = [
	{ name: "goal", description: "Set or manage the session goal" },
	{ name: "cron", description: "Schedule prompts and manage scheduled jobs" },
	{ name: "run", description: "Launch a subagent task" },
	{ name: "chain", description: "Run a sequence of subagent tasks" },
	{ name: "parallel", description: "Run independent subagent tasks" },
	{ name: "mcp", description: "Show configured MCP servers" },
	{ name: "lsp", description: "Show language server status" },
];

export function resolveWithinRoots(path: string, roots: string[]): string {
	const actual = realpathSync(resolve(path));
	if (
		!roots.some((root) => {
			try {
				const rel = relative(realpathSync(root), actual);
				return (
					rel === "" ||
					(!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel))
				);
			} catch {
				return false;
			}
		})
	)
		throw new Error("That path is outside the approved folders.");
	return actual;
}

export function createProjectFolder(parent: string, name: string, roots: string[]): string {
	if (
		!name ||
		name === "." ||
		name === ".." ||
		/[\\/\x00-\x1f<>:"|?*]/.test(name) ||
		/[. ]$/.test(name) ||
		/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)
	)
		throw new Error("Use a simple folder name without slashes or reserved characters.");
	const actual = resolveWithinRoots(parent, roots);
	mkdirSync(join(actual, name));
	return resolveWithinRoots(join(actual, name), roots);
}

interface MobileContext {
	key: string;
	event: MessageEvent;
	adapter: PlatformAdapter;
	bridge: BridgeLike;
	cfg: GatewayConfig;
}

async function browseProject(ctx: MobileContext, initialPath?: string): Promise<void> {
	const { key, event, adapter, bridge } = ctx;
	const roots = ctx.cfg.projectRoots ?? [];
	if (!roots.length) throw new Error("Add approved project folders with lunr gateway setup first.");
	let current: string | undefined = initialPath
		? resolveWithinRoots(initialPath, ctx.cfg.projectRoots ?? [])
		: undefined;
	const view = (): { title: string; items: PickerItem[] } => {
		if (!current)
			return {
				title: "Choose a project folder",
				items: [...new Set([...(conversationBinding(key)?.recentProjects ?? []), ...roots])]
					.filter((p) => {
						try {
							resolveWithinRoots(p, roots);
							return true;
						} catch {
							return false;
						}
					})
					.map((p) => ({ label: p, value: p })),
			};
		current = resolveWithinRoots(current, roots);
		const items: PickerItem[] = [
			{ label: "Use this folder", value: "use" },
			{ label: "New folder", value: "new" },
			{ label: "Recent and roots", value: "roots" },
		];
		try {
			const up = resolveWithinRoots(dirname(current), roots);
			if (up !== current) items.push({ label: "Up", value: up });
		} catch {}
		for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!item.isDirectory() && !item.isSymbolicLink()) continue;
			try {
				const path = resolveWithinRoots(join(current, item.name), roots);
				if (statSync(path).isDirectory()) items.push({ label: item.name, value: path });
			} catch {}
		}
		return { title: current, items };
	};
	const initial = view();
	await createPicker(
		adapter,
		event.source,
		{
			kind: "project",
			sessionKey: key,
			invokerId: event.source.userId,
			...initial,
			validate: () => isGatewayOwner(event.source, loadGatewayConfig()),
			resolve: async (item): Promise<PickerResolveResult> => {
				requireGatewayOwner(event.source);
				if (item.value === "use" && current) {
					const cwd = resolveWithinRoots(current, loadGatewayConfig().projectRoots ?? []);
					if (bridge.getStatus(key).busy)
						throw new Error("Stop the current turn or wait before switching projects.");
					await bridge.reset(key);
					bindConversation(key, event.source, { cwd, owner: event.source.userId });
					return {
						done: true,
						text: `Project selected: ${cwd}\nSend a task to begin. Existing sessions are still available through /sessions.`,
					};
				}
				if (item.value === "new" && current) {
					const name = await gatewayInput(key, "New folder name");
					if (name) current = createProjectFolder(current, name, loadGatewayConfig().projectRoots ?? []);
				} else current = item.value === "roots" ? undefined : item.value;
				return { done: false, ...view() };
			},
		},
		{ threadId: event.source.threadId },
	);
}

const transfers = new Map<string, AbortController>();
export function cancelMobileTransfer(key: string): void {
	transfers.get(key)?.abort();
}

async function continueSession(ctx: MobileContext, file: string): Promise<void> {
	if (transfers.has(ctx.key)) throw new Error("A session transfer is already pending. Use /stop to cancel it.");
	const controller = new AbortController();
	transfers.set(ctx.key, controller);
	try {
		await performContinue(ctx, file, controller.signal);
	} finally {
		transfers.delete(ctx.key);
	}
}

async function performContinue(ctx: MobileContext, file: string, signal: AbortSignal): Promise<void> {
	requireGatewayOwner(ctx.event.source);
	const { requestSessionTransfer, SessionTransferError } = await import("../core/session-handoff.ts");
	const { key, bridge } = ctx;
	const current = await bridge.getSession(key);
	if (current?.sessionManager?.getSessionFile() === file) {
		await ctx.adapter.send(ctx.event.source.chatId, "This session is already open here.");
		return;
	}
	if (bridge.getStatus(key).busy) throw new Error("Stop the current phone session before switching.");
	try {
		await requestSessionTransfer(file, { timeoutMs: 3000, signal });
	} catch (error) {
		if (!(error instanceof SessionTransferError) || error.code !== "busy") throw error;
		const choice = await gatewaySelect(
			key,
			`${error instanceof Error ? error.message : "Session is in use"}\nHow should lunR continue?`,
			["Wait until idle", "Stop and continue", "Cancel"],
			{ signal },
		);
		if (!choice || choice === "Cancel") return;
		if (choice === "Stop and continue") await requestSessionTransfer(file, { stop: true, timeoutMs: 30_000, signal });
		else {
			const deadline = Date.now() + 120_000;
			for (;;) {
				signal.throwIfAborted();
				requireGatewayOwner(ctx.event.source);
				try {
					await requestSessionTransfer(file, { timeoutMs: 3000, signal });
					break;
				} catch (retryError) {
					if (
						!(retryError instanceof SessionTransferError) ||
						retryError.code !== "busy" ||
						Date.now() >= deadline
					)
						throw retryError;
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
	}
	signal.throwIfAborted();
	requireGatewayOwner(ctx.event.source);
	await bridge.switchSession(key, file);
	const session = await bridge.getSession(key);
	const cwd = session?.sessionManager?.getCwd();
	bindConversation(key, ctx.event.source, { cwd, owner: ctx.event.source.userId });
	const id = session?.sessionManager?.getSessionId();
	if (id && ["auto", "yolo"].includes(getPermissionMode(id))) {
		const requested = getPermissionMode(id);
		setPermissionMode("read-only", id);
		session?.sessionManager?.setPermissionMode?.("read-only");
		if (
			(await gatewaySelect(
				key,
				`Continue with ${requested} permissions? Tools can change files and run commands without individual approval.`,
				["Keep read-only", `Use ${requested}`],
			)) === `Use ${requested}`
		) {
			setPermissionMode(requested, id);
			session?.sessionManager?.setPermissionMode?.(requested);
		}
	}
	await ctx.adapter.send(
		ctx.event.source.chatId,
		`Continuing ${session?.sessionManager?.getSessionName() ?? basename(file)}\nProject: ${cwd}\nSend your next instruction.`,
		{ threadId: ctx.event.source.threadId },
	);
}

async function browseSessions(ctx: MobileContext, args: string, quick: boolean): Promise<void> {
	const handoff = await import("../core/session-handoff.ts");
	if (quick) {
		const candidates = handoff.listHandoffCandidates();
		if (!candidates.length) {
			const latest = handoff.latestTuiSession();
			if (!latest)
				throw new Error("No recent TUI session found. Use /sessions or mark one in the terminal with /handoff.");
			await continueSession(ctx, latest.sessionFile);
			return;
		}
		if (candidates.length === 1) {
			await continueSession(ctx, candidates[0].sessionFile);
			return;
		}
		await sessionPicker(
			ctx,
			candidates.map((s) => ({ label: `${s.cwd} · ${basename(s.sessionFile)}`, value: s.sessionFile })),
		);
		return;
	}
	const sessions = await SessionManager.listAll();
	const known = new Set(sessions.map((s) => s.path));
	for (const file of handoff.listRegisteredSessionPaths()) {
		if (known.has(file)) continue;
		try {
			const manager = SessionManager.openReadOnly(file);
			const header = manager.getHeader();
			if (header)
				sessions.push({
					id: header.id,
					path: file,
					cwd: manager.getCwd(),
					name: manager.getSessionName(),
					created: new Date(header.timestamp),
					modified: statSync(file).mtime,
					messageCount: manager.getEntries().length,
					firstMessage: "",
					allMessagesText: "",
				});
		} catch {}
	}
	const query = args.toLowerCase();
	const items = sessions
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.filter((s) => !query || `${s.name ?? ""} ${s.cwd} ${s.id}`.toLowerCase().includes(query))
		.map((s) => ({
			label: `${s.name || s.firstMessage.slice(0, 35) || s.id.slice(0, 8)} · ${basename(s.cwd)} · ${s.modified.toLocaleDateString()}`,
			value: s.path,
		}));
	await sessionPicker(ctx, items);
}

async function sessionPicker(ctx: MobileContext, items: PickerItem[]): Promise<void> {
	await createPicker(
		ctx.adapter,
		ctx.event.source,
		{
			kind: "sessions",
			sessionKey: ctx.key,
			invokerId: ctx.event.source.userId,
			title: "Choose a session. Use /sessions <search> to filter.",
			items,
			validate: () => isGatewayOwner(ctx.event.source, loadGatewayConfig()),
			resolve: async (item) => {
				await continueSession(ctx, item.value);
				return { done: true, text: "Session selection finished." };
			},
		},
		{ threadId: ctx.event.source.threadId },
	);
}

export async function handleMobileCommand(ctx: MobileContext, command: string, args: string): Promise<boolean> {
	if (!MOBILE_COMMANDS.some((c) => c.name === command) && command !== "resume") return false;
	requireGatewayOwner(ctx.event.source, ctx.cfg);
	bindConversation(ctx.key, ctx.event.source, { owner: ctx.event.source.userId });
	if (command === "project") {
		await browseProject(ctx, args.trim() || undefined);
		return true;
	}
	if (command === "sessions" || command === "resume" || command === "continue") {
		await browseSessions(ctx, args, command === "continue");
		return true;
	}
	const session = await ctx.bridge.getSession(ctx.key);
	if (!session) throw new Error("Select a project and send a task, or use /continue first.");
	const id = session.sessionManager?.getSessionId();
	if (command === "usage") {
		const stats = session.getSessionStats();
		const plans = await (await import("../core/usage-service.ts")).getAllPlanUsageResults(
			session.model?.provider,
			session.modelRuntime,
		);
		await ctx.adapter.send(
			ctx.event.source.chatId,
			[
				`Tokens: ${stats.tokens.total} · cost: $${stats.cost.toFixed(4)}`,
				...plans.usages.flatMap((p) =>
					p.windows.map((w) => `${p.provider} ${w.label}: ${w.usedPercent.toFixed(1)}% used`),
				),
				...plans.errors,
			].join("\n"),
		);
		return true;
	}
	if (command === "processes") {
		if (!id) throw new Error("No session identity.");
		const processes = await import("../core/process-registry.ts");
		const own = processes.list(id);
		if (args) {
			const [action, raw] = args.split(/\s+/);
			const pid = Number(raw);
			if (action !== "stop" || !own.some((p) => p.pid === pid))
				throw new Error("Usage: /processes stop <pid> from this session's process list.");
			processes.kill(pid);
			await ctx.adapter.send(ctx.event.source.chatId, `Stop requested for process ${pid}.`);
		} else
			await ctx.adapter.send(
				ctx.event.source.chatId,
				own.length
					? own
							.map((p) => `${p.pid} · ${p.status} · ${p.command}`)
							.join("\n")
							.slice(0, ctx.adapter.maxMessageLength)
					: "No tracked processes.",
			);
		return true;
	}
	if (command === "stopall") {
		await ctx.bridge.abort(ctx.key);
		const result = id ? await getSubagentCancellation(id)?.stop() : undefined;
		const processes = await import("../core/process-registry.ts");
		const count = id ? processes.list(id).filter((p) => p.status !== "exited").length : 0;
		if (id) processes.killAll(id);
		await ctx.adapter.send(
			ctx.event.source.chatId,
			`Stopped the current turn. Requested stop for ${result?.requested ?? 0} background runs and ${count} tracked processes${result?.failed ? `; ${result.failed} requests failed` : ""}. Wait for them to exit before transferring.`,
		);
		return true;
	}
	if (ctx.bridge.getStatus(ctx.key).busy) throw new Error("Wait for the current turn or use /stop first.");
	if (command === "refresh") {
		await session.modelRuntime.refresh();
		await ctx.adapter.send(ctx.event.source.chatId, "Model catalog refreshed. Use /model to choose.");
		return true;
	}
	if (command === "fast") {
		if (session.model?.provider !== "openai-codex" || !session.settingsManager)
			throw new Error("Fast mode is available only for OpenAI Codex subscriptions.");
		const current = session.settingsManager.getOpenAIFastMode();
		if (args && !["on", "off", "status"].includes(args)) throw new Error("Usage: /fast on|off|status");
		if (args !== "status") session.settingsManager.setOpenAIFastMode(args ? args === "on" : !current);
		await ctx.adapter.send(
			ctx.event.source.chatId,
			`Fast mode: ${session.settingsManager.getOpenAIFastMode() ? "on" : "off"}`,
		);
		return true;
	}
	if (command === "skill") {
		const names = session.resourceLoader?.getSkills().skills.map((s) => s.name) ?? [];
		const [name, ...task] = args.split(/\s+/).filter(Boolean);
		const chosen = name || (await gatewaySelect(ctx.key, "Choose a skill", names));
		if (!chosen) return true;
		if (!names.includes(chosen)) throw new Error("That skill is not loaded for this project.");
		ctx.event.text = `/skill:${chosen} ${task.join(" ") || (await gatewayInput(ctx.key, "What should this skill do?")) || ""}`;
		return false;
	}
	if (command === "download") {
		if (!ctx.adapter.sendFile) throw new Error("This platform cannot send files.");
		if (!args) throw new Error("Usage: /download <project-relative path>");
		const cwd = session.sessionManager?.getCwd();
		if (!cwd) throw new Error("No project selected.");
		const file = resolveWithinRoots(resolve(cwd, args), [cwd]);
		const stat = statSync(file);
		if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Choose a file no larger than 8 MB.");
		if (
			/(^|[\\/])(?:\.env(?:\.[^\\/]*)?|auth\.json|gateway\.json|credentials[^\\/]*|id_rsa|id_ed25519)([\\/]|$)/i.test(
				file,
			)
		)
			throw new Error("Credential files cannot be sent through chat.");
		const result = await ctx.adapter.sendFile(ctx.event.source.chatId, file, { threadId: ctx.event.source.threadId });
		if (!result.success) throw new Error(result.error ?? "File delivery failed.");
		return true;
	}
	if (command === "settings") {
		const choice = await gatewaySelect(ctx.key, "Session settings", ["Model", "Thinking", "Permissions"]);
		if (choice === "Model" || choice === "Thinking") {
			const { CHAT_COMMANDS, runChatCommand } = await import("./commands.ts");
			const cmd = CHAT_COMMANDS.find((c) => c.name === choice.toLowerCase());
			if (cmd)
				await runChatCommand(cmd, {
					...ctx,
					args: "",
					reply: async (text) => {
						await ctx.adapter.send(ctx.event.source.chatId, text);
					},
				});
			return true;
		}
		if (choice !== "Permissions") return true;
	}
	const requested =
		command === "plan"
			? "read-only"
			: args || (await gatewaySelect(ctx.key, `Permission mode: ${getPermissionMode(id)}`, [...PERMISSION_MODES]));
	if (!requested) return true;
	const mode = requested === "read" ? "read-only" : requested;
	if (!PERMISSION_MODES.includes(mode as (typeof PERMISSION_MODES)[number]))
		throw new Error("Choose yolo, auto, or read-only.");
	setPermissionMode(mode as (typeof PERMISSION_MODES)[number], id);
	session.sessionManager?.setPermissionMode?.(mode as (typeof PERMISSION_MODES)[number]);
	await ctx.adapter.send(ctx.event.source.chatId, `Permission mode: ${mode}`);
	if (command === "plan" && args) {
		ctx.event.text = `Create a plan for: ${args}`;
		return false;
	}
	return true;
}
