import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type CancelNotification,
	type CloseSessionRequest,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionModeState,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { VERSION } from "../../config.ts";
import { PERMISSION_MODES } from "../../core/permissions.ts";
import { AcpRpcProcess, type WorkerOptions } from "./process.ts";
import { AcpSession } from "./session.ts";
import { type AcpSessionRecord, AcpSessionStore } from "./store.ts";
import {
	customMessageUpdates,
	modelOptions,
	promptTitle,
	promptToLunr,
	toolContent,
	toolKind,
	toolLocations,
} from "./translate.ts";
import { parseAcpWorkerConfig } from "./worker-config.ts";

type SessionOwner = { session: AcpSession; directory: string; record: AcpSessionRecord; configSignature?: string };
const AVAILABLE_MODES = [
	{
		id: "yolo",
		name: "Build",
		description: "lunr can use tools and ask questions. The client handles tool approvals.",
	},
	{
		id: "auto",
		name: "Autonomous",
		description: "lunr works without asking questions. The client still handles tool approvals.",
	},
	{ id: "read-only", name: "Plan", description: "lunr blocks writes and other mutating tools." },
];

// adapted from pi-acp's agent/session split, with lunr-owned configuration and native journals.
export class LunrAcpAgent implements Agent {
	private capabilities: InitializeRequest["clientCapabilities"] = {};
	private initialized = false;
	private closing = false;
	private readonly sessions = new Map<string, SessionOwner>();
	private readonly creating = new Set<Promise<SessionOwner>>();
	private readonly loading = new Set<string>();
	private readonly operations = new Set<string>();
	private readonly connection: AgentSideConnection;
	private readonly args: string[];
	private readonly store: AcpSessionStore;
	private readonly spawnWorker: (options: WorkerOptions) => AcpRpcProcess;

	constructor(
		connection: AgentSideConnection,
		args: string[] = [],
		store = new AcpSessionStore(),
		spawnWorker: (options: WorkerOptions) => AcpRpcProcess = (options) => new AcpRpcProcess(options),
	) {
		this.connection = connection;
		this.args = args;
		this.store = store;
		this.spawnWorker = spawnWorker;
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		if (this.initialized) throw new RequestError(-32602, "ACP connection is already initialized.");
		this.initialized = true;
		this.capabilities = params.clientCapabilities ?? {};
		return {
			protocolVersion: 1,
			agentInfo: { name: "lunr", title: "lunR", version: VERSION },
			authMethods: [],
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				mcpCapabilities: { http: true, sse: true },
				sessionCapabilities: { list: {}, resume: {}, close: {} },
			},
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<void> {
		throw new RequestError(-32602, "Configure model access in lunr's terminal interface before connecting ACP.");
	}

	private assertReady(): void {
		if (!this.initialized || this.closing) throw new RequestError(-32602, "Initialize an open ACP connection first.");
	}

	private get(id: string): SessionOwner {
		this.assertReady();
		if (this.loading.has(id)) throw new RequestError(-32602, "This session is loading.");
		const owner = this.sessions.get(id);
		if (!owner) throw new RequestError(-32602, `Unknown session: ${id}`);
		return owner;
	}

	private async whileIdle<T>(id: string, action: (owner: SessionOwner) => Promise<T>): Promise<T> {
		const owner = this.get(id);
		if (this.operations.has(id) || owner.session.busy)
			throw new RequestError(-32602, "The session is still working. Wait for completion or cancel it first.");
		this.operations.add(id);
		try {
			return await action(owner);
		} finally {
			this.operations.delete(id);
		}
	}

	private async create(params: NewSessionRequest, record?: AcpSessionRecord): Promise<SessionOwner> {
		this.assertReady();
		if (!isAbsolute(params.cwd)) throw new RequestError(-32602, "The project directory must be an absolute path.");
		if (params.additionalDirectories?.length)
			throw new RequestError(-32602, "Additional project directories are not supported.");
		const cwd = await realpath(params.cwd);
		if (!(await stat(cwd)).isDirectory()) throw new RequestError(-32602, "The project directory does not exist.");
		if (record && (await realpath(record.cwd)) !== cwd)
			throw new RequestError(-32602, "This session belongs to a different project.");
		const config = parseAcpWorkerConfig({ mcpServers: params.mcpServers });
		const directory = await mkdtemp(join(tmpdir(), "lunr-acp-"));
		let worker: AcpRpcProcess | undefined;
		try {
			const configPath = join(directory, "worker.json");
			await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
			worker = this.spawnWorker({ cwd, configPath, args: this.args, sessionPath: record?.sessionFile });
			const { data: state } = await worker.request({ type: "get_state" }, 60_000);
			if (!state.model)
				throw RequestError.authRequired({
					message: "No usable lunr model. Open lunr in a terminal and configure model access first.",
				});
			if (!state.sessionFile) throw new Error("ACP requires a persistent lunr session.");
			if (record && state.sessionId !== record.id) throw new Error("The saved lunr session identity changed.");
			const next = {
				id: state.sessionId,
				cwd,
				sessionFile: state.sessionFile,
				title: state.sessionName ?? record?.title,
				updatedAt: record?.updatedAt ?? new Date().toISOString(),
			};
			const owner: SessionOwner = {
				directory,
				record: next,
				session: new AcpSession(next.id, cwd, worker, this.connection, this.capabilities ?? {}, async (title) => {
					owner.record = { ...owner.record, title, updatedAt: new Date().toISOString() };
					this.store.put(owner.record);
				}),
			};
			if (this.closing) throw new Error("ACP connection closed during startup.");
			this.store.put(next);
			this.sessions.set(next.id, owner);
			return owner;
		} catch (error) {
			await worker?.stop();
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	private trackedCreate(params: NewSessionRequest, record?: AcpSessionRecord): Promise<SessionOwner> {
		const pending = this.create(params, record);
		this.creating.add(pending);
		void pending.then(
			() => this.creating.delete(pending),
			() => this.creating.delete(pending),
		);
		return pending;
	}

	private async configuration(
		owner: SessionOwner,
	): Promise<{ configOptions: SessionConfigOption[]; modes: SessionModeState }> {
		const worker = owner.session.process;
		const [
			{ data: state },
			{
				data: { models },
			},
			{
				data: { levels },
			},
		] = await Promise.all([
			worker.request({ type: "get_state" }),
			worker.request({ type: "get_available_models" }),
			worker.request({ type: "get_available_thinking_levels" }),
		]);
		const currentModeId = state.permissionMode ?? "yolo";
		const configOptions: SessionConfigOption[] = [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: state.model ? `${state.model.provider}/${state.model.id}` : "",
				options: modelOptions(models),
			},
			{
				id: "thought_level",
				name: "Reasoning",
				category: "thought_level",
				type: "select",
				currentValue: state.thinkingLevel,
				options: levels.map((level) => ({ value: level, name: level })),
			},
			{
				id: "mode",
				name: "lunR mode",
				category: "mode",
				type: "select",
				currentValue: currentModeId,
				options: AVAILABLE_MODES.map((mode) => ({
					value: mode.id,
					name: mode.name,
					description: mode.description,
				})),
			},
		];
		const result = { configOptions, modes: { currentModeId, availableModes: AVAILABLE_MODES } };
		owner.configSignature = JSON.stringify(result);
		return result;
	}

	private async publishConfiguration(owner: SessionOwner): Promise<void> {
		const previous = owner.configSignature;
		const { configOptions, modes } = await this.configuration(owner);
		if (previous !== owner.configSignature) {
			owner.session.emit({ sessionUpdate: "config_option_update", configOptions });
			owner.session.emit({ sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId });
		}
	}

	private async publishSetup(owner: SessionOwner): Promise<void> {
		const {
			data: { commands },
		} = await owner.session.process.request({ type: "get_commands" });
		owner.session.emit({
			sessionUpdate: "available_commands_update",
			availableCommands: [
				{ name: "compact", description: "Compact this conversation", input: { hint: "optional instructions" } },
				...commands
					.filter((command) => command.name !== "compact")
					.map((command) => ({ name: command.name, description: command.description ?? command.name })),
			],
		});
		await owner.session.publishUsage();
		await owner.session.flush();
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const owner = await this.trackedCreate(params);
		try {
			const configuration = await this.configuration(owner);
			await this.publishSetup(owner);
			return { sessionId: owner.record.id, ...configuration };
		} catch (error) {
			await this.closeSession({ sessionId: owner.record.id });
			throw error;
		}
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.restore(params, true);
	}

	async resumeSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.restore(params, false);
	}

	private async restore(params: LoadSessionRequest, replay: boolean): Promise<LoadSessionResponse> {
		this.assertReady();
		if (this.loading.has(params.sessionId)) throw new RequestError(-32602, "This session is already loading.");
		this.loading.add(params.sessionId);
		try {
			const record = this.store.get(params.sessionId);
			if (!record) throw new RequestError(-32602, "Unknown saved lunr session.");
			if (!isAbsolute(params.cwd) || (await realpath(params.cwd)) !== (await realpath(record.cwd)))
				throw new RequestError(-32602, "This session belongs to a different project.");
			if (params.additionalDirectories?.length)
				throw new RequestError(-32602, "Additional project directories are not supported.");
			parseAcpWorkerConfig({ mcpServers: params.mcpServers });
			const existing = this.sessions.get(params.sessionId);
			if (existing?.session.busy || this.operations.has(params.sessionId))
				throw new RequestError(-32602, "Cancel this session before loading it again.");
			if (existing) await this.closeSession({ sessionId: params.sessionId });
			const owner = await this.trackedCreate(params, record);
			try {
				if (replay) await this.replay(owner);
				const config = await this.configuration(owner);
				await this.publishSetup(owner);
				return config;
			} catch (error) {
				await this.closeSession({ sessionId: owner.record.id });
				throw error;
			}
		} finally {
			this.loading.delete(params.sessionId);
		}
	}

	private async replay(owner: SessionOwner): Promise<void> {
		const {
			data: { messages },
		} = await owner.session.process.request({ type: "get_messages" });
		for (const message of messages) {
			if (message.role === "user") {
				const blocks =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				for (const content of blocks) owner.session.emit({ sessionUpdate: "user_message_chunk", content });
			} else if (message.role === "assistant") {
				for (const content of message.content) {
					if (content.type === "text")
						owner.session.emit({
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: content.text },
						});
					else if (content.type === "thinking")
						owner.session.emit({
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: content.thinking },
						});
					else if (content.type === "toolCall")
						owner.session.emit({
							sessionUpdate: "tool_call",
							toolCallId: content.id,
							title: content.name,
							kind: toolKind(content.name),
							status: "pending",
							rawInput: content.arguments,
							locations: toolLocations(content.arguments, owner.record.cwd),
						});
				}
			} else if (message.role === "toolResult") {
				owner.session.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: message.toolCallId,
					status: message.isError ? "failed" : "completed",
					content: toolContent(message),
				});
			} else if (message.role === "custom") {
				for (const update of customMessageUpdates(message)) owner.session.emit(update);
			}
		}
		await owner.session.flush();
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.whileIdle(params.sessionId, async (owner) => {
			const { message, images } = promptToLunr(params.prompt);
			if (!message.trim() && !images.length) throw new RequestError(-32602, "The prompt is empty.");
			const stopReason = await owner.session.prompt(message, images);
			if (this.sessions.get(params.sessionId) !== owner || !owner.session.process.usable) return { stopReason };
			if (!owner.record.title) {
				const title = promptTitle(message);
				if (title) await owner.session.process.request({ type: "set_session_name", name: title });
				owner.record.title = title;
			}
			owner.record.updatedAt = new Date().toISOString();
			this.store.put(owner.record);
			await this.publishConfiguration(owner);
			await owner.session.flush();
			return { stopReason };
		});
	}

	async cancel(params: CancelNotification): Promise<void> {
		await this.get(params.sessionId).session.cancel();
	}

	async closeSession(params: CloseSessionRequest): Promise<void> {
		const owner = this.sessions.get(params.sessionId);
		if (!owner) return;
		this.sessions.delete(params.sessionId);
		try {
			await owner.session.dispose();
		} finally {
			await rm(owner.directory, { recursive: true, force: true });
		}
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		this.assertReady();
		const cwd = params.cwd ? await realpath(params.cwd) : undefined;
		const records = this.store.list().filter((record) => !cwd || record.cwd === cwd);
		const offset = params.cursor ? Number(params.cursor) : 0;
		if (!Number.isSafeInteger(offset) || offset < 0) throw new RequestError(-32602, "Invalid session list cursor.");
		return {
			sessions: records.slice(offset, offset + 100).map((record) => ({
				sessionId: record.id,
				cwd: record.cwd,
				title: record.title,
				updatedAt: record.updatedAt,
			})),
			...(offset + 100 < records.length ? { nextCursor: String(offset + 100) } : {}),
		};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<void> {
		await this.setSessionConfigOption({ sessionId: params.sessionId, configId: "mode", value: params.modeId });
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		if (typeof params.value !== "string") throw new RequestError(-32602, "Expected a selection value.");
		if (params.configId === "mode") {
			// acp allows mode changes during a turn; lunr's tool gates read the mode on each call.
			const owner = this.get(params.sessionId);
			const mode = PERMISSION_MODES.find((mode) => mode === params.value);
			if (!mode) throw new RequestError(-32602, "Unknown lunr mode.");
			await owner.session.process.request({ type: "set_permission_mode", mode });
			owner.session.emit({ sessionUpdate: "current_mode_update", currentModeId: mode });
			return this.publishConfigOptions(owner);
		}
		return this.whileIdle(params.sessionId, async (owner) => {
			const worker = owner.session.process;
			if (params.configId === "model") {
				const {
					data: { models },
				} = await worker.request({ type: "get_available_models" });
				const model = models.find((model) => `${model.provider}/${model.id}` === params.value);
				if (!model) throw new RequestError(-32602, "Unknown lunr model.");
				await worker.request({ type: "set_model", provider: model.provider, modelId: model.id });
			} else if (params.configId === "thought_level") {
				const {
					data: { levels },
				} = await worker.request({ type: "get_available_thinking_levels" });
				if (!isValidThinkingLevel(params.value) || !levels.includes(params.value))
					throw new RequestError(-32602, "Unsupported reasoning level.");
				await worker.request({ type: "set_thinking_level", level: params.value });
			} else throw new RequestError(-32602, "Unknown lunr configuration option.");
			return this.publishConfigOptions(owner);
		});
	}

	private async publishConfigOptions(owner: SessionOwner): Promise<SetSessionConfigOptionResponse> {
		const { configOptions } = await this.configuration(owner);
		owner.session.emit({ sessionUpdate: "config_option_update", configOptions });
		await owner.session.flush();
		return { configOptions };
	}

	async dispose(): Promise<void> {
		this.closing = true;
		await Promise.allSettled(this.creating);
		await Promise.allSettled([...this.sessions.keys()].map((sessionId) => this.closeSession({ sessionId })));
	}
}
