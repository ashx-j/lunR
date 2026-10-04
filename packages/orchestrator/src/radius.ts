import { hostname, platform } from "node:os";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { getOrchestratorDir, getSocketPath, VERSION } from "./config.ts";
import { withDeadline } from "./deadline.ts";
import { loadMachine, saveMachine } from "./storage.ts";
import type { InstanceRecord, MachineRecord, RadiusRegistration } from "./types.ts";

const DEFAULT_RADIUS_URL = "https://radius.pi.dev/";
const DEFAULT_ORCHESTRATOR_BASE_PATH = "/v1/";
const NOT_FOUND_RETRY_THRESHOLD = 3;
const HEARTBEAT_BACKOFF_BASE_MS = 1_000;
const HEARTBEAT_BACKOFF_MAX_MS = 30_000;
const RADIUS_PROVIDER = "radius";
export const RADIUS_REQUEST_TIMEOUT_MS = 5_000;

interface RegisterMachineResponse extends RadiusRegistration {
	id: string;
}

interface RegisterPiResponse extends RadiusRegistration {
	id: string;
}

interface RadiusPresenceCoordinator {
	getLiveInstance(instanceId: string): InstanceRecord | undefined;
	listLiveInstances(): InstanceRecord[];
	updateInstance(instance: InstanceRecord): void;
}

interface PiHeartbeatState {
	generation: number;
	ownerCreatedAt: string;
	recovery?: { controller: AbortController; promise: Promise<boolean> };
	timer?: NodeJS.Timeout;
	intervalMs: number;
	radiusPiId: string;
	consecutiveNotFoundCount: number;
	transientFailureCount: number;
}

class RadiusHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RadiusHttpError";
		this.status = status;
	}
}

interface RegistrationOwnership<T> {
	signal: AbortSignal;
	disposeLateResult(result: T): Promise<void>;
}

async function post<T>(path: string, body: unknown, ownership?: RegistrationOwnership<T>): Promise<T> {
	return withDeadline(
		async (deadlineSignal) => {
			const signal = ownership ? AbortSignal.any([deadlineSignal, ownership.signal]) : deadlineSignal;
			signal.throwIfAborted();
			let onAbort: () => void = () => {};
			const cancelled = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			});
			// Keep this continuation even if cancellation wins and a transport ignores its signal.
			const request = (async () => {
				const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
					method: "POST",
					signal,
					headers: {
						Authorization: `Bearer ${getRadiusAccessToken()}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new RadiusHttpError(
						response.status,
						`Radius request failed: ${response.status} ${await response.text()}`,
					);
				}
				const result = (await response.json()) as T;
				if (signal.aborted) {
					await ownership?.disposeLateResult(result);
					throw signal.reason;
				}
				return result;
			})();
			try {
				return await Promise.race([request, cancelled]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		RADIUS_REQUEST_TIMEOUT_MS,
		`Radius ${path}`,
	);
}

async function maybePost(path: string, body: unknown): Promise<void> {
	return withDeadline(
		async (signal) => {
			const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
				method: "POST",
				signal,
				headers: {
					Authorization: `Bearer ${getRadiusAccessToken()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				throw new RadiusHttpError(
					response.status,
					`Radius request failed: ${response.status} ${await response.text()}`,
				);
			}
		},
		RADIUS_REQUEST_TIMEOUT_MS,
		`Radius ${path}`,
	);
}

function isNotFoundError(error: unknown): error is RadiusHttpError {
	return error instanceof RadiusHttpError && error.status === 404;
}

function computeBackoffDelayMs(failureCount: number): number {
	const exponentialDelay = Math.min(
		HEARTBEAT_BACKOFF_MAX_MS,
		HEARTBEAT_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
	);
	const jitterMs = Math.floor(Math.random() * Math.max(250, exponentialDelay / 4));
	return Math.min(HEARTBEAT_BACKOFF_MAX_MS, exponentialDelay + jitterMs);
}

function formatRadiusError(error: unknown): string {
	if (error instanceof RadiusHttpError) {
		return `HTTP ${error.status}: ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function logRadiusRetry(scope: string, action: string, delayMs: number, failureCount: number, error: unknown): void {
	console.error(
		`${scope} ${action} failed (attempt ${failureCount}); retrying in ${delayMs}ms: ${formatRadiusError(error)}`,
	);
}

export function getRadiusUrl(): string {
	return process.env.PI_RADIUS_URL || DEFAULT_RADIUS_URL;
}

export function getRadiusOrchestratorBaseUrl(): string {
	const explicitUrl = process.env.PI_RADIUS_ORCHESTRATOR_URL;
	if (explicitUrl) {
		return explicitUrl;
	}

	return new URL(DEFAULT_ORCHESTRATOR_BASE_PATH, getRadiusUrl()).toString();
}

function getStoredRadiusCredential(): OAuthCredential | undefined {
	const credential = readStoredCredential(RADIUS_PROVIDER);
	return credential?.type === "oauth" ? credential : undefined;
}

export function getRadiusAccessToken(): string {
	const storedCredential = getStoredRadiusCredential();
	if (typeof storedCredential?.access === "string" && storedCredential.access) {
		return storedCredential.access;
	}

	const apiKey = process.env.RADIUS_API_KEY;
	if (apiKey) {
		return apiKey;
	}

	throw new Error("Radius credentials are required in ~/.lunr/agent/auth.json or RADIUS_API_KEY");
}

export function isRadiusEnabled(): boolean {
	return !!getStoredRadiusCredential()?.access || !!process.env.RADIUS_API_KEY;
}

export class RadiusPresence {
	private stopped = false;
	private generation = 0;
	private lifecycle = new AbortController();
	private readonly pendingPiDisconnects = new Set<string>();
	private readonly pendingMachineDisconnects = new Set<string>();
	private machineHeartbeatTimer?: NodeJS.Timeout;
	private machineHeartbeatIntervalMs = 0;
	private machineConsecutiveNotFoundCount = 0;
	private machineTransientFailureCount = 0;
	private readonly piHeartbeatStates = new Map<string, PiHeartbeatState>();
	private machine?: MachineRecord;
	private machineGeneration?: number;
	private coordinator?: RadiusPresenceCoordinator;

	setCoordinator(coordinator: RadiusPresenceCoordinator): void {
		this.coordinator = coordinator;
	}

	async start(label?: string): Promise<MachineRecord | undefined> {
		if (this.machineHeartbeatTimer) clearTimeout(this.machineHeartbeatTimer);
		this.machineHeartbeatTimer = undefined;
		this.lifecycle.abort(new Error("Radius presence replaced"));
		this.lifecycle = new AbortController();
		this.generation += 1;
		const generation = this.generation;
		this.stopped = false;
		if (!isRadiusEnabled()) {
			return undefined;
		}

		const registered = await this.registerMachine(label);
		if (this.stopped || this.generation !== generation) return undefined;
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);
		return this.machine;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.generation += 1;
		this.lifecycle.abort(new Error("Radius presence stopped"));
		if (this.machineHeartbeatTimer) {
			clearTimeout(this.machineHeartbeatTimer);
			this.machineHeartbeatTimer = undefined;
		}
		const pending: Promise<unknown>[] = [];
		for (const state of this.piHeartbeatStates.values()) {
			if (state.timer) clearTimeout(state.timer);
			state.recovery?.controller.abort(new Error("Radius presence stopped"));
			if (state.recovery) pending.push(state.recovery.promise.catch(() => undefined));
		}
		this.piHeartbeatStates.clear();
		if (this.machine && isRadiusEnabled()) pending.push(this.disposeMachineRegistration(this.machine.id));
		for (const id of this.pendingPiDisconnects) pending.push(this.disposePiRegistration(id));
		for (const id of this.pendingMachineDisconnects) {
			if (id !== this.machine?.id) pending.push(this.disposeMachineRegistration(id));
		}
		const results = await Promise.allSettled(pending);
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "Radius shutdown cleanup failed");
	}

	async registerPi(
		instance: InstanceRecord,
		recovery?: { signal: AbortSignal; isCurrent(): boolean },
	): Promise<InstanceRecord> {
		if (!isRadiusEnabled()) return instance;
		const generation = this.generation;
		const machine = this.machine ?? loadMachine();
		if (!machine) throw new Error("No registered machine available for Pi registration");
		const signal = recovery ? AbortSignal.any([this.lifecycle.signal, recovery.signal]) : this.lifecycle.signal;
		const registered = await post<RegisterPiResponse>(
			"pis/register",
			{
				machineId: machine.id,
				label: instance.label,
				cwd: instance.cwd,
				hostname: hostname(),
				pid: process.pid,
				transport: "local-rpc",
				capabilities: { rpc: true, relay: false, iroh: false },
				sessionId: instance.sessionId,
			},
			{ signal, disposeLateResult: (result) => this.disposePiRegistration(result.id) },
		);
		const current = this.coordinator?.getLiveInstance(instance.id);
		if (
			this.stopped ||
			this.generation !== generation ||
			(recovery && !recovery.isCurrent()) ||
			(this.coordinator &&
				(!current ||
					current.createdAt !== instance.createdAt ||
					(current.status !== "online" && current.status !== "starting")))
		) {
			await this.disposePiRegistration(registered.id);
			return instance;
		}
		const registeredInstance = { ...instance, radiusPiId: registered.id };
		this.startPiHeartbeat(instance, registered.heartbeatIntervalMs, registered.id);
		return registeredInstance;
	}

	async disconnectPi(instance: InstanceRecord): Promise<void> {
		const candidate = this.piHeartbeatStates.get(instance.id);
		const state = candidate?.ownerCreatedAt === instance.createdAt ? candidate : undefined;
		if (state) {
			if (state.timer) clearTimeout(state.timer);
			this.piHeartbeatStates.delete(instance.id);
			state.recovery?.controller.abort(new Error("Radius instance stopped"));
			await state.recovery?.promise.catch(() => undefined);
		}
		if (!isRadiusEnabled()) return;
		const ids = new Set([instance.radiusPiId, state?.radiusPiId]);
		const results = await Promise.allSettled(
			[...ids].filter((id): id is string => !!id).map((id) => this.disposePiRegistration(id)),
		);
		const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 0) throw new AggregateError(errors, "Radius instance disconnect failed");
	}

	private async disposePiRegistration(id: string): Promise<void> {
		// A replacement can receive the same remote ID. Never disconnect its active registration.
		if (
			!this.stopped &&
			[...this.piHeartbeatStates.entries()].some(([instanceId, state]) => {
				const current = this.coordinator?.getLiveInstance(instanceId);
				return (
					state.generation === this.generation &&
					state.radiusPiId === id &&
					(!this.coordinator ||
						(current?.createdAt === state.ownerCreatedAt &&
							(current.status === "online" || current.status === "starting")))
				);
			})
		)
			return;
		await this.disposeRegistration("pis", id, this.pendingPiDisconnects);
	}

	private async disposeMachineRegistration(id: string): Promise<void> {
		if (!this.stopped && this.machineGeneration === this.generation && this.machine?.id === id) return;
		await this.disposeRegistration("machines", id, this.pendingMachineDisconnects);
	}

	private async disposeRegistration(kind: "pis" | "machines", id: string, pending: Set<string>): Promise<void> {
		pending.add(id);
		try {
			await maybePost(`${kind}/${id}/disconnect`, {});
			pending.delete(id);
		} catch (error) {
			if (isNotFoundError(error)) {
				pending.delete(id);
				return;
			}
			console.error(`Radius ${kind}/${id} cleanup failed: ${formatRadiusError(error)}`);
			throw error;
		}
	}

	private async registerMachine(label?: string): Promise<RegisterMachineResponse> {
		const generation = this.generation;
		const existingMachine = this.machine ?? loadMachine();
		const registered = await post<RegisterMachineResponse>(
			"machines/register",
			{
				machineId: existingMachine?.id,
				label,
				hostname: hostname(),
				platform: platform(),
				arch: process.arch,
				version: VERSION,
				capabilities: { spawn: true, relay: false, iroh: false },
			},
			{ signal: this.lifecycle.signal, disposeLateResult: (result) => this.disposeMachineRegistration(result.id) },
		);
		if (this.stopped || this.generation !== generation) {
			await this.disposeMachineRegistration(registered.id);
			throw new Error("Radius presence stopped during machine registration");
		}

		const timestamp = new Date().toISOString();
		this.machine = {
			id: registered.id,
			createdAt: existingMachine?.createdAt ?? timestamp,
			lastSeenAt: timestamp,
			label,
		};
		this.machineGeneration = generation;
		saveMachine(this.machine);
		this.machineConsecutiveNotFoundCount = 0;
		this.machineTransientFailureCount = 0;
		return registered;
	}

	private startMachineHeartbeat(intervalMs: number): void {
		this.machineHeartbeatIntervalMs = intervalMs;
		this.scheduleMachineHeartbeat(intervalMs);
	}

	private scheduleMachineHeartbeat(delayMs: number): void {
		if (this.stopped) return;
		if (this.machineHeartbeatTimer) {
			clearTimeout(this.machineHeartbeatTimer);
		}
		this.machineHeartbeatTimer = setTimeout(() => {
			void this.heartbeatMachine();
		}, delayMs);
	}

	private startPiHeartbeat(instance: InstanceRecord, intervalMs: number, radiusPiId: string): void {
		const instanceId = instance.id;
		if (this.stopped) return;
		const existingState = this.piHeartbeatStates.get(instanceId);
		if (existingState?.timer) {
			clearTimeout(existingState.timer);
		}
		const state: PiHeartbeatState =
			existingState?.generation === this.generation && existingState.ownerCreatedAt === instance.createdAt
				? existingState
				: {
						generation: this.generation,
						ownerCreatedAt: instance.createdAt,
						intervalMs,
						radiusPiId,
						consecutiveNotFoundCount: 0,
						transientFailureCount: 0,
					};
		if (existingState && existingState !== state) {
			existingState.recovery?.controller.abort(new Error("Radius instance replaced"));
		}
		state.intervalMs = intervalMs;
		state.radiusPiId = radiusPiId;
		state.consecutiveNotFoundCount = 0;
		state.transientFailureCount = 0;
		this.piHeartbeatStates.set(instanceId, state);
		this.schedulePiHeartbeat(instanceId, intervalMs);
	}

	private schedulePiHeartbeat(instanceId: string, delayMs: number): void {
		const state = this.piHeartbeatStates.get(instanceId);
		if (!state || this.stopped || state.generation !== this.generation) {
			return;
		}
		if (state.timer) {
			clearTimeout(state.timer);
		}
		state.timer = setTimeout(() => {
			void this.heartbeatPi(instanceId);
		}, delayMs);
	}

	private async heartbeatMachine(): Promise<void> {
		if (this.stopped || !this.machine || !isRadiusEnabled()) {
			return;
		}

		const generation = this.generation;
		try {
			await maybePost(`machines/${this.machine.id}/heartbeat`, {
				cwd: getOrchestratorDir(),
				socketPath: getSocketPath(),
			});
			if (this.stopped || this.generation !== generation) return;
			this.machineConsecutiveNotFoundCount = 0;
			this.machineTransientFailureCount = 0;
			this.scheduleMachineHeartbeat(this.machineHeartbeatIntervalMs);
		} catch (error) {
			if (this.stopped || this.generation !== generation) return;
			if (!isNotFoundError(error)) {
				this.machineTransientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(this.machineTransientFailureCount);
				logRadiusRetry("Radius machine", "heartbeat", delayMs, this.machineTransientFailureCount, error);
				this.scheduleMachineHeartbeat(delayMs);
				return;
			}

			this.machineTransientFailureCount = 0;
			this.machineConsecutiveNotFoundCount += 1;
			if (this.machineConsecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				this.scheduleMachineHeartbeat(this.machineHeartbeatIntervalMs);
				return;
			}

			try {
				await this.reRegisterMachineAndPis();
			} catch (recoveryError) {
				if (this.stopped || this.generation !== generation) return;
				this.machineTransientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(this.machineTransientFailureCount);
				logRadiusRetry(
					"Radius machine",
					"re-registration",
					delayMs,
					this.machineTransientFailureCount,
					recoveryError,
				);
				this.scheduleMachineHeartbeat(delayMs);
			}
		}
	}

	private async heartbeatPi(instanceId: string): Promise<void> {
		if (!isRadiusEnabled()) {
			return;
		}

		const state = this.piHeartbeatStates.get(instanceId);
		if (!state || this.stopped || state.generation !== this.generation) {
			return;
		}

		try {
			await maybePost(`pis/${state.radiusPiId}/heartbeat`, {});
			if (this.stopped || state.generation !== this.generation || this.piHeartbeatStates.get(instanceId) !== state)
				return;
			state.consecutiveNotFoundCount = 0;
			state.transientFailureCount = 0;
			this.schedulePiHeartbeat(instanceId, state.intervalMs);
		} catch (error) {
			if (this.stopped || state.generation !== this.generation || this.piHeartbeatStates.get(instanceId) !== state)
				return;
			if (!isNotFoundError(error)) {
				state.transientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(state.transientFailureCount);
				logRadiusRetry(`Radius Pi ${instanceId}`, "heartbeat", delayMs, state.transientFailureCount, error);
				this.schedulePiHeartbeat(instanceId, delayMs);
				return;
			}

			state.transientFailureCount = 0;
			state.consecutiveNotFoundCount += 1;
			if (state.consecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				this.schedulePiHeartbeat(instanceId, state.intervalMs);
				return;
			}

			try {
				const recovered = await this.reRegisterPi(instanceId);
				if (!recovered && !this.stopped && this.piHeartbeatStates.get(instanceId) === state) {
					const delayMs = computeBackoffDelayMs(1);
					console.error(`Radius Pi ${instanceId} re-registration skipped; retrying in ${delayMs}ms`);
					this.schedulePiHeartbeat(instanceId, delayMs);
				}
			} catch (recoveryError) {
				if (this.stopped || this.piHeartbeatStates.get(instanceId) !== state) return;
				state.transientFailureCount += 1;
				const delayMs = computeBackoffDelayMs(state.transientFailureCount);
				logRadiusRetry(
					`Radius Pi ${instanceId}`,
					"re-registration",
					delayMs,
					state.transientFailureCount,
					recoveryError,
				);
				this.schedulePiHeartbeat(instanceId, delayMs);
			}
		}
	}

	private async reRegisterMachineAndPis(): Promise<void> {
		if (this.stopped) return;
		const generation = this.generation;
		const registered = await this.registerMachine(this.machine?.label);
		if (this.stopped || this.generation !== generation) return;
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);

		if (this.stopped) return;
		const instances = this.coordinator?.listLiveInstances() ?? [];
		for (const instance of instances) {
			if (this.stopped || this.generation !== generation) return;
			try {
				await this.reRegisterPi(instance.id);
			} catch (error) {
				console.error(`Radius Pi ${instance.id} re-registration failed: ${formatRadiusError(error)}`);
			}
		}
	}

	private async reRegisterPi(instanceId: string): Promise<boolean> {
		if (this.stopped) return false;
		const instance = this.coordinator?.getLiveInstance(instanceId);
		if (!instance || (instance.status !== "online" && instance.status !== "starting")) {
			const state = this.piHeartbeatStates.get(instanceId);
			if (state) {
				state.recovery?.controller.abort(new Error("Radius instance no longer active"));
				if (state.timer) {
					clearTimeout(state.timer);
				}
				this.piHeartbeatStates.delete(instanceId);
			}
			return false;
		}

		if (!this.machine) {
			await this.reRegisterMachineAndPis();
			return true;
		}

		const state = this.piHeartbeatStates.get(instanceId);
		if (!state || state.generation !== this.generation || state.ownerCreatedAt !== instance.createdAt) return false;
		if (state.recovery) return state.recovery.promise;
		const generation = this.generation;
		const isCurrent = () => {
			const current = this.coordinator?.getLiveInstance(instanceId);
			return (
				!this.stopped &&
				this.generation === generation &&
				this.piHeartbeatStates.get(instanceId) === state &&
				current?.createdAt === instance.createdAt &&
				current.pid === instance.pid &&
				(current.status === "online" || current.status === "starting")
			);
		};
		const controller = new AbortController();
		const promise = (async () => {
			const registered = await this.registerPi(instance, { signal: controller.signal, isCurrent });
			if (!isCurrent()) return false;
			const current = this.coordinator?.getLiveInstance(instanceId);
			if (current) this.coordinator?.updateInstance({ ...current, radiusPiId: registered.radiusPiId });
			return true;
		})();
		const recovery = { controller, promise };
		state.recovery = recovery;
		try {
			return await promise;
		} finally {
			if (state.recovery === recovery) state.recovery = undefined;
		}
	}
}

export const radiusPresence = new RadiusPresence();
