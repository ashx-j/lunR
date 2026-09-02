import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getInstancesPath, getMachinePath, getOrchestratorDir } from "./config.ts";
import type { InstanceRecord, InstanceStatus, MachineRecord } from "./types.ts";

function ensureOrchestratorDir(): void {
	const orchestratorDir = getOrchestratorDir();
	if (!existsSync(orchestratorDir)) {
		mkdirSync(orchestratorDir, { recursive: true });
	}
}

function atomicWriteJson(path: string, value: unknown): void {
	ensureOrchestratorDir();
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(tempPath, "wx", 0o600);
		writeFileSync(fd, JSON.stringify(value, null, 2));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(tempPath, path);
		try {
			const directoryFd = openSync(dirname(path), "r");
			try {
				fsyncSync(directoryFd);
			} finally {
				closeSync(directoryFd);
			}
		} catch {
			// Directory fsync is unavailable on some platforms.
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(tempPath, { force: true });
	}
}

function quarantineCorruptFile(path: string, error: unknown): string | undefined {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const quarantinePath = `${path}.corrupt-${timestamp}-${randomUUID()}`;
	try {
		renameSync(path, quarantinePath);
		console.error(`Quarantined corrupt orchestrator state at ${quarantinePath}: ${String(error)}`);
		return quarantinePath;
	} catch (quarantineError) {
		console.error(
			`Failed to quarantine corrupt orchestrator state at ${path}: ${String(error)}; ${String(quarantineError)}`,
		);
		return undefined;
	}
}

function loadJson<T>(path: string, validate: (value: unknown) => value is T): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!validate(parsed)) throw new Error("unexpected JSON shape");
		return parsed;
	} catch (error) {
		quarantineCorruptFile(path, error);
		return undefined;
	}
}

const INSTANCE_STATUSES = new Set<InstanceStatus>(["starting", "online", "stopping", "stopped", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isRequiredString(record: Record<string, unknown>, key: string): boolean {
	return typeof record[key] === "string" && record[key].length > 0;
}

function hasValidOptionalStrings(record: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => record[key] === undefined || typeof record[key] === "string");
}

function isMachineRecord(value: unknown): value is MachineRecord {
	if (!isRecord(value)) return false;
	return (
		isRequiredString(value, "id") &&
		isRequiredString(value, "createdAt") &&
		hasValidOptionalStrings(value, ["lastSeenAt", "label"])
	);
}

function isInstanceRecord(value: unknown): value is InstanceRecord {
	if (!isRecord(value)) return false;
	return (
		isRequiredString(value, "id") &&
		isRequiredString(value, "cwd") &&
		isRequiredString(value, "createdAt") &&
		typeof value.status === "string" &&
		INSTANCE_STATUSES.has(value.status as InstanceStatus) &&
		hasValidOptionalStrings(value, ["lastSeenAt", "label", "sessionId", "sessionFile", "radiusPiId"])
	);
}

export function loadMachine(): MachineRecord | undefined {
	return loadJson(getMachinePath(), isMachineRecord);
}

export function saveMachine(machine: MachineRecord): void {
	atomicWriteJson(getMachinePath(), machine);
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) return;
	rmSync(machinePath);
}

export function loadInstances(): InstanceRecord[] {
	return (
		loadJson(
			getInstancesPath(),
			(value): value is InstanceRecord[] => Array.isArray(value) && value.every(isInstanceRecord),
		) ?? []
	);
}

export function saveInstances(instances: InstanceRecord[]): void {
	atomicWriteJson(getInstancesPath(), instances);
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
