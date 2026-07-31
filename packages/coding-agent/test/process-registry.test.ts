import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as registry from "../src/core/process-registry.ts";
import { isWindows } from "../src/core/process-registry.ts";

// Helper to register a process with a fake start time in the past.
function registerWithStartTime(pid: number, command: string, cwd: string, ageMs: number) {
	const originalNow = Date.now;
	Date.now = () => originalNow() - ageMs;
	try {
		registry.register(pid, command, cwd);
	} finally {
		Date.now = originalNow;
	}
}
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
		// After explicit kill, the entry is removed (user action, not retained).
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
		try {
			process.kill(child.pid);
		} catch {}
	});

	it("markExited deletes short-lived processes immediately (noise gate)", () => {
		registry.register(1, "echo hi", "/tmp");
		registry.markExited(1, 0);
		expect(registry.list().find((p) => p.pid === 1)).toBeUndefined();
	});

	it("markExited retains longer-lived processes as exited with exit code", () => {
		registerWithStartTime(2, "sleep 5", "/tmp", 4000);
		registry.markExited(2, 42);
		const tracked = registry.list().find((p) => p.pid === 2);
		expect(tracked).toBeDefined();
		expect(tracked?.status).toBe("exited");
		expect(tracked?.exitCode).toBe(42);
		expect(tracked?.exitedAt).toBeGreaterThan(0);
	});

	it("evicts exited entries after the TTL", () => {
		registerWithStartTime(3, "sleep 5", "/tmp", 4000);
		registry.markExited(3, 0);
		expect(registry.list().find((p) => p.pid === 3)).toBeDefined();

		// Move time past the 5-minute TTL.
		const originalNow = Date.now;
		Date.now = () => originalNow() + 6 * 60 * 1000;
		try {
			expect(registry.list().find((p) => p.pid === 3)).toBeUndefined();
		} finally {
			Date.now = originalNow;
		}
	});
	it("caps the number of tracked entries", () => {
		for (let i = 1; i <= 110; i++) {
			registerWithStartTime(i, `proc-${i}`, "/tmp", 4000);
			registry.markExited(i, 0);
		}
		const list = registry.list();
		expect(list.length).toBeLessThanOrEqual(100);
		// Oldest entries are evicted first.
		expect(list.find((p) => p.pid === 1)).toBeUndefined();
		// Newest entries survive.
		expect(list.find((p) => p.pid === 110)).toBeDefined();
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

	it("lists only processes for the requested session id", async () => {
		const { spawn } = await import("node:child_process");
		const child = spawn("node", ["-e", "setTimeout(() => {}, 5000)"], {
			detached: true,
			stdio: "ignore",
		});
		if (!child.pid) return;
		registry.register(child.pid, "node -e setTimeout", "/tmp", "session-a");
		expect(registry.list("session-a").find((p) => p.pid === child.pid)).toBeDefined();
		expect(registry.list("session-b").find((p) => p.pid === child.pid)).toBeUndefined();
		expect(registry.list().find((p) => p.pid === child.pid)).toBeDefined();
		registry.kill(child.pid);
	});
});
