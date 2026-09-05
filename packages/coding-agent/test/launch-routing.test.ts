import { describe, expect, it } from "vitest";
import { resolvePreloadLaunchMode } from "../src/startup/launch-routing.ts";

const terminal = { stdinIsTTY: true, stdoutIsTTY: true, startupBenchmark: false };
describe("early launch routing", () => {
	it.each([
		[],
		["hello"],
		["--continue"],
		["--resume"],
		["--session", "abc"],
		["--name", "--print"],
		["--mode", "rpc", "--mode", "text"],
	])("paints interactive launch %j", (...args) => {
		expect(resolvePreloadLaunchMode(args, terminal)).toBe("interactive");
	});
	it.each([
		["--help"],
		["--version"],
		["-p", "hello"],
		["--mode", "rpc"],
		["--mode", "json"],
		["--list-models"],
		["--export", "session.jsonl"],
		["gateway"],
		["update"],
		["install", "package"],
	])("keeps command %j off the TUI path", (...args) => {
		expect(resolvePreloadLaunchMode(args, terminal)).toBe("deferred");
	});
	it("does not take over piped input or redirected output", () => {
		expect(resolvePreloadLaunchMode([], { ...terminal, stdinIsTTY: false })).toBe("deferred");
		expect(resolvePreloadLaunchMode([], { ...terminal, stdoutIsTTY: false })).toBe("deferred");
	});
	it("allows an explicit headless benchmark while keeping RPC noninteractive", () => {
		const env = { stdinIsTTY: false, stdoutIsTTY: false, startupBenchmark: true };
		expect(resolvePreloadLaunchMode([], env)).toBe("interactive");
		expect(resolvePreloadLaunchMode(["--mode", "rpc"], env)).toBe("deferred");
	});
});
