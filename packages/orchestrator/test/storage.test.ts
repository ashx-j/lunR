import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInstancesPath } from "../src/config.ts";
import { loadInstances, saveInstances } from "../src/storage.ts";
import { OrchestratorSupervisor } from "../src/supervisor.ts";

const originalOrchestratorDir = process.env.PI_ORCHESTRATOR_DIR;

describe("orchestrator state storage", () => {
	let directory: string;

	beforeEach(() => {
		directory = join(tmpdir(), `lunr-orchestrator-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		process.env.PI_ORCHESTRATOR_DIR = directory;
		mkdirSync(directory, { recursive: true });
	});

	afterEach(() => {
		if (originalOrchestratorDir === undefined) delete process.env.PI_ORCHESTRATOR_DIR;
		else process.env.PI_ORCHESTRATOR_DIR = originalOrchestratorDir;
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("writes complete state through an atomic temporary file", () => {
		const instance = {
			id: "instance-1",
			status: "online" as const,
			cwd: directory,
			createdAt: "2026-01-01T00:00:00.000Z",
		};
		saveInstances([instance]);
		expect(loadInstances()).toEqual([instance]);
		expect(JSON.parse(readFileSync(getInstancesPath(), "utf8"))).toEqual([instance]);
		expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("quarantines parseable state with invalid records", () => {
		writeFileSync(getInstancesPath(), JSON.stringify([{ id: "instance-1", status: "mystery", cwd: directory }]));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(loadInstances()).toEqual([]);
		expect(existsSync(getInstancesPath())).toBe(false);
		expect(readdirSync(directory).filter((name) => name.startsWith("instances.json.corrupt-"))).toHaveLength(1);
	});

	it("quarantines truncated state and lets restart recovery continue", async () => {
		writeFileSync(getInstancesPath(), '[{"id":"broken"');
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const supervisor = new OrchestratorSupervisor({
			createRpcProcess: () => {
				throw new Error("not used");
			},
			radius: {
				registerPi: async (instance) => instance,
				disconnectPi: async () => {},
			},
		});

		await expect(supervisor.recoverAfterRestart()).resolves.toBeUndefined();
		expect(loadInstances()).toEqual([]);
		expect(existsSync(getInstancesPath())).toBe(true);
		const quarantined = readdirSync(directory).filter((name) => name.startsWith("instances.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(readFileSync(join(directory, quarantined[0]), "utf8")).toBe('[{"id":"broken"');
		expect(error).toHaveBeenCalledWith(expect.stringContaining("Quarantined corrupt orchestrator state"));
	});
});
