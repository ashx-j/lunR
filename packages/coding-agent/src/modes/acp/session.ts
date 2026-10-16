import { readFileSync, statSync } from "node:fs";
import {
	type AgentSideConnection,
	type ClientCapabilities,
	RequestError,
	type SessionUpdate,
	type StopReason,
	type ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { RpcAcpPermissionRequest, RpcExtensionUIRequest } from "../rpc/rpc-types.ts";
import type { AcpRpcProcess, WorkerEvent } from "./process.ts";
import { customMessageUpdates, toolContent, toolKind, toolLocations } from "./translate.ts";

type Turn = {
	resolve: (reason: StopReason) => void;
	reject: (error: Error) => void;
	cancelled: boolean;
	accepted: boolean;
	clientCancelled: boolean;
	hostCancellation: Promise<void>;
	releaseHostDialogs: () => void;
	finishing?: Promise<void>;
	failure?: Error;
	error?: string;
};
type AcpClient = Pick<AgentSideConnection, "sessionUpdate" | "requestPermission" | "unstable_createElicitation">;
type DialogResponse = { confirmed: boolean } | { value: string } | { cancelled: true };

// retains pi-acp's ordered updates, pre-edit snapshots and agent_settled completion boundary.
export class AcpSession {
	private turn?: Turn;
	private running = false;
	private activity = 0;
	private settling = false;
	private settleTimer?: ReturnType<typeof setTimeout>;
	private output = Promise.resolve();
	private noticeCount = 0;
	private readonly tools = new Map<string, "pending" | "in_progress" | "completed" | "failed">();
	private readonly snapshots = new Map<string, { path: string; oldText: string | null }>();
	private readonly dialogs = new Map<string, { cancel: () => void; closed: Promise<void> }>();
	private disposed = false;
	readonly id: string;
	readonly cwd: string;
	readonly process: AcpRpcProcess;
	private readonly connection: AcpClient;
	private readonly capabilities: ClientCapabilities;
	private readonly onTitle: (title: string) => Promise<void>;

	constructor(
		id: string,
		cwd: string,
		process: AcpRpcProcess,
		connection: AcpClient,
		capabilities: ClientCapabilities,
		onTitle: (title: string) => Promise<void>,
	) {
		this.id = id;
		this.cwd = cwd;
		this.process = process;
		this.connection = connection;
		this.capabilities = capabilities;
		this.onTitle = onTitle;
		process.onEvent((event) => this.handleEvent(event));
		process.onExit((error) => {
			if (this.settleTimer) clearTimeout(this.settleTimer);
			if (this.turn) void this.finishTurn(this.turn, error);
		});
	}

	get busy(): boolean {
		return Boolean(this.turn) || this.running;
	}

	emit(update: SessionUpdate): void {
		this.output = this.output.then(() => this.connection.sessionUpdate({ sessionId: this.id, update }));
		void this.output.catch((error: unknown) => {
			// a broken client transport cannot answer or dismiss its remaining dialogs.
			this.turn?.releaseHostDialogs();
			if (this.turn) void this.finishTurn(this.turn, error);
			void this.process.stop();
		});
	}

	async flush(): Promise<void> {
		await this.output;
	}

	async prompt(message: string, images: ImageContent[]): Promise<StopReason> {
		if (this.disposed) throw new RequestError(-32602, "Session is closed.");
		if (this.busy)
			throw new RequestError(-32602, "This session is still working. Wait for completion or cancel it first.");
		return new Promise<StopReason>((resolve, reject) => {
			let releaseHostDialogs = () => {};
			const hostCancellation = new Promise<void>((done) => {
				releaseHostDialogs = done;
			});
			const turn: Turn = {
				resolve,
				reject,
				cancelled: false,
				accepted: false,
				clientCancelled: false,
				hostCancellation,
				releaseHostDialogs,
			};
			this.turn = turn;
			void (async () => {
				if (images.length) {
					const { data } = await this.process.request({ type: "get_state" });
					if (!data.model?.input.includes("image"))
						throw new RequestError(-32602, "The selected model does not support images.");
				}
				if (turn.cancelled || this.disposed) return;
				// command handlers can wait for user input; cancellation, not a timer, owns this request.
				if (/^\/compact(?:\s|$)/.test(message) && !images.length) {
					await this.process.request(
						{ type: "compact", customInstructions: message.slice(8).trim() || undefined },
						0,
					);
				} else {
					await this.process.request({ type: "prompt", message, images }, 0);
				}
			})()
				.then(() => {
					turn.accepted = true;
					// slash commands can finish without starting an agent run.
					return this.settle(turn);
				})
				.catch((error: unknown) => {
					return this.finishTurn(turn, error);
				});
		});
	}

	private async finishTurn(turn: Turn, error?: unknown): Promise<void> {
		if (this.turn !== turn) return;
		if (error !== undefined) turn.failure = error instanceof Error ? error : new Error(String(error));
		if (turn.finishing) return turn.finishing;
		turn.finishing = (async () => {
			this.cancelDialogs();
			try {
				if (this.dialogs.size && !turn.clientCancelled && !this.disposed) {
					// acp v1 cannot retract host requests; keep them inside the turn until the client closes them.
					const notice = this.notice(
						"This question or approval is no longer needed. Dismiss it or stop the turn to finish.",
						"in_progress",
					);
					await Promise.race([
						Promise.all([...this.dialogs.values()].map((dialog) => dialog.closed)),
						turn.hostCancellation,
					]);
					this.emit({ sessionUpdate: "tool_call_update", toolCallId: notice, status: "completed" });
				}
				await this.flush();
				if (turn.cancelled) turn.resolve("cancelled");
				else if (turn.failure || turn.error) turn.reject(turn.failure ?? new Error(turn.error));
				else turn.resolve("end_turn");
			} catch (failure) {
				turn.reject(failure instanceof Error ? failure : new Error(String(failure)));
			} finally {
				if (this.turn === turn) this.turn = undefined;
				this.running = false;
				this.tools.clear();
				this.snapshots.clear();
			}
		})();
		return turn.finishing;
	}

	private settleLater(): void {
		if (this.settleTimer || !this.turn || this.disposed) return;
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			void this.settle();
		}, 250);
	}

	private async settle(turn = this.turn): Promise<void> {
		if (!turn?.accepted || this.turn !== turn || turn.finishing) return;
		if (this.settling) {
			this.settleLater();
			return;
		}
		this.settling = true;
		const activity = this.activity;
		try {
			const { data } = await this.process.request({ type: "get_state" });
			if (data.isStreaming || data.isCompacting || data.pendingMessageCount > 0 || this.turn !== turn) return;
			if (data.pendingSubagents) {
				this.settleLater();
				return;
			}
			await this.publishUsage();
			await this.flush();
			const { data: final } = await this.process.request({ type: "get_state" });
			if (this.turn !== turn) return;
			if (
				this.running ||
				this.activity !== activity ||
				final.isStreaming ||
				final.isCompacting ||
				final.pendingMessageCount > 0 ||
				final.pendingSubagents
			) {
				this.settleLater();
				return;
			}
			await this.finishTurn(turn);
		} catch (error) {
			await this.finishTurn(turn, error);
		} finally {
			this.settling = false;
		}
	}

	async publishUsage(): Promise<void> {
		try {
			const { data } = await this.process.request({ type: "get_session_stats" }, 1_000);
			const usage = data.contextUsage;
			if (
				usage &&
				usage.tokens !== null &&
				Number.isSafeInteger(usage.tokens) &&
				usage.tokens >= 0 &&
				usage.contextWindow > 0
			) {
				this.emit({ sessionUpdate: "usage_update", used: usage.tokens, size: usage.contextWindow });
			}
		} catch {
			/* context accounting must not hold a completed turn open. */
		}
	}

	private cancelDialogs(): void {
		for (const dialog of this.dialogs.values()) dialog.cancel();
	}

	async cancel(): Promise<void> {
		if (this.turn) {
			this.turn.cancelled = true;
			this.turn.clientCancelled = true;
			this.turn.releaseHostDialogs();
		}
		this.cancelDialogs();
		// an explicit client cancellation also dismisses its own requests.
		this.dialogs.clear();
		if (this.process.usable) await this.process.request({ type: "abort" });
		await this.settle();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		if (this.turn) {
			this.turn.cancelled = true;
			this.turn.releaseHostDialogs();
		}
		this.cancelDialogs();
		this.dialogs.clear();
		await this.process.stop();
	}

	private startTool(
		id: string,
		name: string,
		input: Record<string, unknown>,
		status: "pending" | "in_progress",
	): void {
		const previous = this.tools.get(id);
		if (previous === "completed" || previous === "failed") return;
		const effective = previous === "in_progress" ? previous : status;
		this.tools.set(id, effective);
		const update = {
			toolCallId: id,
			title: name === "bash" && typeof input.command === "string" ? input.command : name,
			kind: toolKind(name),
			status: effective,
			rawInput: input,
			locations: toolLocations(input, this.cwd),
		};
		this.emit(
			previous ? { ...update, sessionUpdate: "tool_call_update" } : { ...update, sessionUpdate: "tool_call" },
		);
	}

	private handleEvent(event: WorkerEvent): void {
		switch (event.type) {
			case "agent_start":
				this.activity++;
				this.running = true;
				if (this.turn) this.turn.error = undefined;
				break;
			case "agent_settled":
				this.activity++;
				this.running = false;
				void this.settle();
				break;
			case "message_update": {
				const update = event.assistantMessageEvent;
				if (update.type === "text_delta" || update.type === "thinking_delta") {
					this.emit({
						sessionUpdate: update.type === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk",
						content: { type: "text", text: update.delta },
					});
				} else if (
					update.type === "toolcall_start" ||
					update.type === "toolcall_delta" ||
					update.type === "toolcall_end"
				) {
					const call = update.partial.content[update.contentIndex];
					if (call?.type === "toolCall") this.startTool(call.id, call.name, call.arguments, "pending");
				}
				break;
			}
			case "message_end": {
				if (event.message.role === "custom") {
					for (const update of customMessageUpdates(event.message)) this.emit(update);
				}
				if (event.message.role === "assistant" && this.turn) {
					if (event.message.stopReason === "error")
						this.turn.error = event.message.errorMessage ?? "The model request failed.";
					if (event.message.stopReason === "aborted") {
						this.turn.cancelled = true;
						this.cancelDialogs();
					}
				}
				break;
			}
			case "tool_execution_start": {
				this.startTool(event.toolCallId, event.toolName, event.args, "in_progress");
				const path = toolLocations(event.args, this.cwd)?.[0]?.path;
				if (path && (event.toolName === "edit" || event.toolName === "write")) {
					try {
						if (statSync(path).size <= 1_048_576)
							this.snapshots.set(event.toolCallId, { path, oldText: readFileSync(path, "utf8") });
					} catch (error) {
						if (error instanceof Error && "code" in error && error.code === "ENOENT")
							this.snapshots.set(event.toolCallId, { path, oldText: null });
					}
				}
				break;
			}
			case "tool_execution_update": {
				this.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: "in_progress",
					content: toolContent(event.partialResult),
				});
				break;
			}
			case "tool_execution_end": {
				const content = toolContent(event.result);
				const snapshot = this.snapshots.get(event.toolCallId);
				if (snapshot && !event.isError) {
					try {
						if (statSync(snapshot.path).size <= 1_048_576) {
							const newText = readFileSync(snapshot.path, "utf8");
							if (newText !== snapshot.oldText) content.push({ type: "diff", ...snapshot, newText });
						}
					} catch {
						/* tools still report their result if a post-edit snapshot is unavailable. */
					}
				}
				this.tools.set(event.toolCallId, event.isError ? "failed" : "completed");
				this.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: event.isError ? "failed" : "completed",
					content,
				});
				this.snapshots.delete(event.toolCallId);
				break;
			}
			case "acp_permission_request":
				void this.permission(event);
				break;
			case "extension_ui_request":
				void this.dialog(event);
				break;
			case "session_info_changed":
				if (event.name) {
					this.emit({ sessionUpdate: "session_info_update", title: event.name });
					void this.onTitle(event.name).catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
				}
				break;
			case "extension_error":
				this.notice(`Extension error: ${event.error}`, "failed");
				break;
		}
	}

	private async permission(event: RpcAcpPermissionRequest): Promise<void> {
		this.startTool(event.toolCallId, event.toolName, event.input, "pending");
		await this.respondToDialog(
			event.id,
			async (signal) => {
				await this.flush();
				if (signal.aborted) return { cancelled: true };
				const result = await this.connection.requestPermission({
					sessionId: this.id,
					toolCall: {
						toolCallId: event.toolCallId,
						title: event.toolName,
						kind: toolKind(event.toolName),
						rawInput: event.input,
						...(event.description
							? {
									content: [
										{ type: "content", content: { type: "text", text: event.description } },
									] satisfies ToolCallContent[],
								}
							: {}),
					},
					options: [
						{ optionId: "allow", name: "Allow once", kind: "allow_once" },
						{ optionId: "reject", name: "Reject", kind: "reject_once" },
					],
				});
				return { confirmed: result.outcome.outcome === "selected" && result.outcome.optionId === "allow" };
			},
			undefined,
			(response) => {
				if (!event.standalone) return;
				// plan and batch approvals have no later tool execution event to finish their card.
				const status = "confirmed" in response && response.confirmed ? "completed" : "failed";
				this.tools.set(event.toolCallId, status);
				this.emit({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status });
			},
		);
	}

	private async respondToDialog(
		id: string,
		request: (signal: AbortSignal) => Promise<DialogResponse>,
		timeout?: number,
		onResponse?: (response: DialogResponse) => void,
	): Promise<void> {
		let active = true;
		const controller = new AbortController();
		const finish = (response: DialogResponse) => {
			if (!active) return;
			active = false;
			onResponse?.(response);
			this.process.respond({ type: "extension_ui_response", id, ...response });
		};
		const cancel = () => {
			controller.abort();
			finish({ cancelled: true });
		};
		let close = () => {};
		const closed = new Promise<void>((resolve) => {
			close = resolve;
		});
		this.dialogs.set(id, { cancel, closed });
		const timer = timeout ? setTimeout(cancel, timeout) : undefined;
		try {
			if (this.disposed || this.turn?.cancelled) {
				cancel();
				return;
			}
			const response = await request(controller.signal);
			finish(response);
		} catch {
			cancel();
		} finally {
			active = false;
			if (timer) clearTimeout(timer);
			this.dialogs.delete(id);
			close();
		}
	}

	// ACP clients concatenate assistant chunks, so notices belong in separate activity entries.
	// Returns the activity id so a caller can update its status later.
	private notice(
		text: string,
		status: "in_progress" | "completed" | "failed",
		id = `lunr-notice-${++this.noticeCount}`,
	) {
		this.emit({
			sessionUpdate: "tool_call",
			toolCallId: id,
			title: "lunR notification",
			kind: "other",
			status,
			content: [{ type: "content", content: { type: "text", text } }],
		});
		return id;
	}

	private async dialog(event: RpcExtensionUIRequest): Promise<void> {
		if (event.method === "notify") {
			this.notice(
				event.message,
				event.notifyType === "error" ? "failed" : "completed",
				`lunr-notification-${event.id}`,
			);
			return;
		}
		if (
			event.method !== "confirm" &&
			event.method !== "select" &&
			event.method !== "input" &&
			event.method !== "editor"
		)
			return;
		await this.respondToDialog(
			event.id,
			async () => {
				if (this.capabilities.elicitation?.form != null) {
					const property =
						event.method === "confirm"
							? { type: "boolean" as const, title: event.message }
							: {
									type: "string" as const,
									...(event.method === "select" ? { enum: event.options } : {}),
									...(event.method === "editor" ? { default: event.prefill } : {}),
								};
					const result = await this.connection.unstable_createElicitation({
						sessionId: this.id,
						mode: "form",
						message: event.title,
						requestedSchema: { type: "object", properties: { answer: property }, required: ["answer"] },
					});
					if (result.action !== "accept") return { cancelled: true };
					const answer = result.content?.answer;
					if (event.method === "confirm" && typeof answer === "boolean") return { confirmed: answer };
					if (typeof answer === "string" && (event.method !== "select" || event.options.includes(answer)))
						return { value: answer };
					return { cancelled: true };
				}
				// never encode a question as an approval: clients can auto-approve permissions.
				this.emit({
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text: `This client cannot show lunr's question: ${event.title}. Reply in chat instead.\n`,
					},
				});
				return { cancelled: true };
			},
			"timeout" in event ? event.timeout : undefined,
		);
	}
}
