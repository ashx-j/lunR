import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as registry from "../src/core/process-registry.ts";
import { isWindows } from "../src/core/process-registry.ts";

describe("process-registry", () => {
	beforeEach(() => {
		registry.clearRegistry();
	});

	afterEach(() => {
		registry.clearRegistry();
	});

	it("starts empty", () => {
		expect(registry.list()).toEqual([]);
	});

	it("registers and lists a process", () => {
		registry.register(99999, "echo test", "/tmp");
		const list = registry.list();
		// 99999 doesn't exist → pruned by liveness probe
		expect(list.find((p) => p.pid === 99999)).toBeUndefined();
	});

	it("tracks a real short-lived process", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) return;
		registry.register(child.pid, "node -e setTimeout", "/tmp");

		const list = registry.list();
		const tracked = list.find((p) => p.pid === child.pid);
		expect(tracked).toBeDefined();
		expect(tracked?.command).toBe("node -e setTimeout");
		expect(tracked?.status).toBe("running");

		registry.kill(child.pid);
		// After kill, it should be pruned from the list
		expect(registry.list().find((p) => p.pid === child.pid)).toBeUndefined();
	});

	it("killAll kills all tracked processes", async () => {
		const { spawn } = await import("node:child_process");
		const child1 = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
			detached: true,
			stdio: "ignore",
		});
		const child2 = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child1.pid || !child2.pid) return;
		registry.register(child1.pid, "proc1", "/tmp");
		registry.register(child2.pid, "proc2", "/tmp");

		expect(registry.list().length).toBeGreaterThanOrEqual(2);
		registry.killAll();
		expect(registry.list().length).toBe(0);
	});

	it("clearRegistry removes all entries", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) return;
		registry.register(child.pid, "test", "/tmp");
		registry.clearRegistry();
		expect(registry.list().length).toBe(0);
		// Clean up
		try { process.kill(child.pid); } catch {}
	});

	it("restart re-spawns and registers a new pid", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) return;
		registry.register(child.pid, "node -e setTimeout", "/tmp");
		const newPid = registry.restart(child.pid);
		expect(newPid).toBeDefined();
		if (newPid) {
			registry.kill(newPid);
		}
	});

	// Skip pause/resume on Windows
	if (!isWindows()) {
		it("pause and resume a process", async () => {
			const { spawn } = await import("node:child_process");
			const child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], {
				detached: true,
				stdio: "ignore",
			});
			if (!child.pid) return;
			registry.register(child.pid, "node -e setTimeout", "/tmp");

			registry.pause(child.pid);
			let list = registry.list();
			let tracked = list.find((p) => p.pid === child.pid);
			expect(tracked?.status).toBe("paused");

			registry.resume(child.pid);
			list = registry.list();
			tracked = list.find((p) => p.pid === child.pid);
			expect(tracked?.status).toBe("running");

			registry.kill(child.pid);
		});
	}
});