import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tpsExtension from "../src/builtin-extensions/pi-tps.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function register(hasUI = true) {
	const handlers = new Map<string, Handler>();
	const setStatus = vi.fn();
	const ctx = { hasUI, ui: { setStatus } } as unknown as ExtensionContext;
	tpsExtension({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	return {
		ctx,
		setStatus,
		emit(name: string, event: unknown = {}) {
			const handler = handlers.get(name);
			if (!handler) throw new Error(`Missing TPS handler: ${name}`);
			return handler(event, ctx);
		},
	};
}

const assistant = { message: { role: "assistant", usage: { output: 120 } } };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TPS animation ownership", () => {
	it("never schedules animation or status work for a headless turn", () => {
		const session = register(false);
		session.emit("agent_start");
		session.emit("message_start", assistant);
		expect(vi.getTimerCount()).toBe(0);
		session.emit("message_update", assistant);
		session.emit("message_end", assistant);
		session.emit("session_shutdown");
		expect(vi.getTimerCount()).toBe(0);
		expect(session.setStatus).not.toHaveBeenCalled();
	});

	it("does not let an interactive animation keep the process alive", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const session = register();
		try {
			session.emit("message_start", assistant);
			const timer = setIntervalSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
			expect(timer.hasRef()).toBe(false);
		} finally {
			session.emit("session_shutdown");
			setIntervalSpy.mockRestore();
		}
	});

	it("stops on completion even when UI availability changes", () => {
		const session = register();
		session.emit("message_start", assistant);
		expect(vi.getTimerCount()).toBe(1);
		session.ctx.hasUI = false;
		session.emit("message_end", assistant);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["agent_end", "session_start", "session_shutdown"])("stops owned work at %s", (boundary) => {
		const session = register();
		session.emit("message_start", assistant);
		expect(vi.getTimerCount()).toBe(1);
		session.ctx.hasUI = false;
		session.emit(boundary);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(session.setStatus).not.toHaveBeenCalled();
	});

	it("keeps two sessions' timers and spinner positions independent", () => {
		const first = register();
		const second = register();
		first.emit("message_start", assistant);
		vi.advanceTimersByTime(80);
		second.emit("message_start", assistant);
		expect(vi.getTimerCount()).toBe(2);
		vi.advanceTimersByTime(1);
		first.emit("message_update", assistant);
		second.emit("message_update", assistant);
		expect(first.setStatus.mock.lastCall?.[1]).toContain("⠙");
		expect(second.setStatus.mock.lastCall?.[1]).toContain("⠋");
		first.emit("session_shutdown");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(80);
		second.emit("message_update", assistant);
		expect(second.setStatus.mock.lastCall?.[1]).toContain("⠙");
		second.emit("session_shutdown");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not leave completion callbacks that repaint a replaced session", () => {
		const session = register();
		session.emit("message_start", assistant);
		vi.advanceTimersByTime(1000);
		session.emit("message_end", assistant);
		expect(session.setStatus.mock.lastCall?.[1]).toContain("120.0 output t/s");
		session.emit("session_start");
		const calls = session.setStatus.mock.calls.length;
		vi.runAllTimers();
		expect(session.setStatus).toHaveBeenCalledTimes(calls);
		expect(vi.getTimerCount()).toBe(0);
	});
});

it("clears completion tokens when the next assistant reports no usage", () => {
	const session = register();
	session.emit("message_start", assistant);
	vi.advanceTimersByTime(1000);
	session.emit("message_end", assistant);
	expect(session.setStatus.mock.lastCall?.[1]).toContain("120 tokens");
	const empty = { message: { role: "assistant", usage: { output: 0 } } };
	session.emit("message_start", empty);
	vi.advanceTimersByTime(1000);
	session.emit("message_end", empty);
	expect(session.setStatus.mock.lastCall?.[1]).toBe("");
});
