import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "../src/serve.ts";

const fakes = vi.hoisted(() => ({
	close: vi.fn(),
	recover: vi.fn(),
	shutdown: vi.fn(),
	startRadius: vi.fn(),
	stopRadius: vi.fn(),
}));
vi.mock("../src/handler.ts", () => ({ handleIpcRequest: vi.fn(), openRpcStream: vi.fn() }));
vi.mock("../src/ipc/server.ts", () => ({ startIpcServer: async () => ({ close: fakes.close }) }));
vi.mock("../src/supervisor.ts", () => ({
	supervisor: { recoverAfterRestart: fakes.recover, shutdown: fakes.shutdown },
}));
vi.mock("../src/radius.ts", () => ({
	isRadiusEnabled: () => true,
	getRadiusOrchestratorBaseUrl: () => "https://example.invalid/v1/",
	radiusPresence: { start: fakes.startRadius, stop: fakes.stopRadius },
}));

let profile: string;
let socketPath: string;
const handlers = new Map<string, (...args: unknown[]) => void>();
const exitCodes: Array<string | number | null | undefined> = [];
beforeEach(() => {
	profile = mkdtempSync(join(tmpdir(), "lunr-orchestrator-serve-"));
	socketPath = join(profile, "orchestrator.sock");
	writeFileSync(socketPath, "fake socket");
	vi.stubEnv("PI_ORCHESTRATOR_DIR", profile);
	vi.stubEnv("HOME", profile);
	for (const name of Object.keys(process.env)) {
		if (/^PI_(?:SUBAGENT_|SUBAGENTS_|INTERCOM_)/.test(name)) vi.stubEnv(name, undefined);
	}
	for (const fake of Object.values(fakes)) fake.mockReset();
	fakes.recover.mockResolvedValue(undefined);
	fakes.shutdown.mockResolvedValue(undefined);
	fakes.startRadius.mockResolvedValue(undefined);
	fakes.stopRadius.mockResolvedValue(undefined);
	handlers.clear();
	exitCodes.length = 0;
	vi.spyOn(process, "on").mockImplementation((event, listener) => {
		handlers.set(String(event), listener);
		return process;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCodes.push(code);
		return undefined as never;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(profile, { recursive: true, force: true });
});

describe("service shutdown call sites", () => {
	it("stops Radius and removes the socket when child cleanup rejects, exiting with failure", async () => {
		fakes.shutdown.mockRejectedValue(new Error("child termination unconfirmed"));
		fakes.stopRadius.mockRejectedValue(new Error("machine disconnect failed"));
		void serve();
		await vi.waitFor(() => expect(handlers.has("SIGTERM")).toBe(true));
		handlers.get("SIGTERM")?.();
		await vi.waitFor(() => expect(exitCodes).toEqual([1]));
		expect(fakes.close).toHaveBeenCalledOnce();
		expect(fakes.shutdown).toHaveBeenCalledOnce();
		expect(fakes.stopRadius).toHaveBeenCalledOnce();
		expect(existsSync(socketPath)).toBe(false);
		expect(console.error).toHaveBeenCalledWith(expect.any(AggregateError));
	});

	it("shares cleanup across repeated signals and preserves a later fatal exit status", async () => {
		let finishShutdown!: () => void;
		fakes.shutdown.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishShutdown = resolve;
				}),
		);
		void serve();
		await vi.waitFor(() => expect(handlers.has("SIGTERM")).toBe(true));
		handlers.get("SIGTERM")?.();
		handlers.get("SIGINT")?.();
		handlers.get("uncaughtException")?.(new Error("fatal during shutdown"));
		finishShutdown();
		await vi.waitFor(() => expect(exitCodes).toEqual([1]));
		expect(fakes.shutdown).toHaveBeenCalledOnce();
		expect(fakes.stopRadius).toHaveBeenCalledOnce();
		expect(existsSync(socketPath)).toBe(false);
	});

	it("attempts all local and remote cleanup after failed startup", async () => {
		fakes.recover.mockRejectedValue(new Error("recovery failed"));
		fakes.shutdown.mockRejectedValue(new Error("child cleanup failed"));
		await expect(serve()).rejects.toThrow("startup and cleanup failed");
		expect(fakes.close).toHaveBeenCalledOnce();
		expect(fakes.shutdown).toHaveBeenCalledOnce();
		expect(fakes.stopRadius).toHaveBeenCalledOnce();
		expect(existsSync(socketPath)).toBe(false);
	});
});
