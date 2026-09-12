import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChildExcludeTools } from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-tools.ts";
import { DesktopLease } from "../src/core/computer-use/lease.ts";
import { COMPUTER_TOOLS, computerRefusal } from "../src/core/computer-use/policy.ts";
import { computerSchemas } from "../src/core/computer-use/schemas.ts";
import { ComputerWorkflow, driverData, driverRefused } from "../src/core/computer-use/workflow.ts";
import {
	createPermissionContext,
	deletePermissionContext,
	gateToolCall,
	registerApprovalHandler,
	resetPermissions,
} from "../src/core/permissions.ts";

vi.mock("../src/utils/image-resize.ts", () => ({
	resizeImage: async () => {
		const bytes = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
		bytes.writeUInt32BE(1024, 16);
		bytes.writeUInt32BE(512, 20);
		return {
			data: bytes.toString("base64"),
			mimeType: "image/png",
			originalWidth: 2048,
			originalHeight: 1024,
			width: 1024,
			height: 512,
			wasResized: true,
		};
	},
}));

const paths: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "lunr-computer-test-"));
	paths.push(path);
	return path;
}
afterEach(async () => {
	resetPermissions();
	registerApprovalHandler(undefined);
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("computer policy", () => {
	it("isolates fresh cron approval contexts from a permissive gateway handler", async () => {
		resetPermissions("auto");
		const handler = vi.fn(async () => "session" as const);
		registerApprovalHandler(handler);
		createPermissionContext("cron-test", "manual", false);
		expect(await gateToolCall("computer_observe", {}, ".", "cron-test")).toMatchObject({ block: true });
		expect(handler).not.toHaveBeenCalled();
		deletePermissionContext("cron-test");
	});
	it("gates observations in manual, permits them in Plan, rejects all unknown computer operations", async () => {
		resetPermissions("manual");
		expect(await gateToolCall("computer_observe", { pid: 1, window_id: 2 }, ".")).toMatchObject({ block: true });
		resetPermissions("plan");
		expect(await gateToolCall("computer_observe", {}, ".")).toBeUndefined();
		expect(await gateToolCall("computer_click", {}, ".")).toMatchObject({ block: true });
		for (const mode of ["auto", "yolo", "manual", "plan"] as const) {
			resetPermissions(mode);
			expect(await gateToolCall("computer_raw", {}, ".")).toMatchObject({ block: true });
		}
	});
	it("excludes all native tools from both child permission sets and guards execution", () => {
		for (const permissions of ["full", "read-only"] as const) {
			expect(resolveChildExcludeTools({ permissions })).toEqual(expect.arrayContaining([...COMPUTER_TOOLS]));
		}
		for (const name of COMPUTER_TOOLS)
			expect(computerRefusal(name, {}, { enabled: true, foreground: true, child: true, vision: true })).toContain(
				"main agents",
			);
	});
	it("enforces feature, foreground and model vision policy", () => {
		const policy = { enabled: true, foreground: false, child: false, vision: false };
		expect(computerRefusal("computer_click", { foreground: true }, policy)).toContain("Foreground");
		expect(computerRefusal("computer_window", {}, policy)).toContain("Foreground");
		expect(computerSchemas.computer_window.properties).not.toHaveProperty("foreground");
		expect(computerSchemas.computer_window.properties).not.toHaveProperty("desktop");
		expect(computerRefusal("computer_click", { desktop: true }, policy)).toContain("Foreground");
		expect(computerRefusal("computer_text", { x: 2, y: 3 }, { ...policy, foreground: true })).toContain("images");
		expect(computerRefusal("computer_click", { x: 2 }, policy)).toContain("images");
		expect(computerRefusal("computer_observe", {}, { ...policy, enabled: false })).toContain("disabled");
		expect(computerRefusal("computer_click", { element_index: 1 }, policy)).toBeUndefined();
	});
});

describe("driver replies", () => {
	it("extracts text JSON snapshots and preserves structured refusals and uncertain effects", () => {
		expect(
			driverRefused({
				content: [],
				structuredContent: { status: "activated", code: "bring_to_front_exact_window_verified", activated: true },
			}),
		).toBe(false);
		expect(driverData({ content: [{ type: "text", text: '{"snapshot_id":"s12345678"}' }] }).snapshot_id).toBe(
			"s12345678",
		);
		expect(
			driverData({
				content: [{ type: "text", text: '{"snapshot_id":"s12345678"}' }],
				structuredContent: [] as unknown as Record<string, unknown>,
			}).snapshot_id,
		).toBe("s12345678");
		for (const data of [
			{ refusal: "background_unavailable" },
			{ effect: "refused" },
			{ status: "blocked" },
			{ code: "stale_snapshot" },
		]) {
			expect(driverRefused({ content: [], structuredContent: data, isError: false })).toBe(true);
		}
		expect(
			driverRefused({ content: [], structuredContent: { effect: "unverifiable", route: "synthetic_events" } }),
		).toBe(false);
	});
});

describe("desktop workflow", () => {
	it.each(["pid", "window_id"])(
		"rejects desktop input carrying a conflicting %s before driver dispatch",
		async (field) => {
			const call = vi.fn(async () => ({
				content: [{ type: "image" as const, data: "fixture", mimeType: "image/png" }],
				structuredContent: { screenshot_width: 2048, screenshot_height: 1024 },
			}));
			const workflow = new ComputerWorkflow(
				{ call, close: async () => undefined },
				new DesktopLease(await directory()),
			);
			const observed = await workflow.execute("computer_observe", { desktop: true });
			await expect(
				workflow.execute("computer_click", {
					desktop: true,
					foreground: true,
					[field]: 1,
					observation: observed.details.observation,
					x: 1,
					y: 1,
				}),
			).rejects.toThrow("Stale observation");
			expect(call).toHaveBeenCalledTimes(1);
		},
	);
	it("maps displayed desktop pixels back to the driver's native image without losing uncertain outcomes", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({
				content: [{ type: "image", data: "fixture", mimeType: "image/png" }],
				structuredContent: { screenshot_width: 2048, screenshot_height: 1024 },
			})
			.mockResolvedValueOnce({ content: [], structuredContent: { effect: "unverifiable", route: "global_input" } });
		const workflow = new ComputerWorkflow(
			{ call, close: async () => undefined },
			new DesktopLease(await directory()),
		);
		const observation = await workflow.execute("computer_observe", { desktop: true });
		const result = await workflow.execute("computer_click", {
			desktop: true,
			foreground: true,
			observation: observation.details.observation,
			x: 512,
			y: 256,
			button: "right",
		});
		expect(call).toHaveBeenLastCalledWith(
			"click",
			{ scope: "desktop", delivery_mode: "foreground", x: 1024, y: 512, button: "right" },
			expect.any(AbortSignal),
		);
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.content)).toContain("unverifiable");
		expect(result.details.observation).toBeUndefined();
		await workflow.close();
	});
	it("invalidates grounding on a refused observation even when isError is false", async () => {
		const call = vi
			.fn()
			.mockResolvedValueOnce({ content: [], structuredContent: { snapshot_id: "s12345678" } })
			.mockResolvedValueOnce({ content: [], isError: false, structuredContent: { refusal: "permission_required" } });
		const workflow = new ComputerWorkflow(
			{ call, close: async () => undefined },
			new DesktopLease(await directory()),
		);
		const first = await workflow.execute("computer_observe", { pid: 1, window_id: 2 });
		const failed = await workflow.execute("computer_observe", { pid: 1, window_id: 2 });
		expect(failed.isError).toBe(true);
		expect(failed.details.observation).toBeUndefined();
		await expect(
			workflow.execute("computer_click", {
				pid: 1,
				window_id: 2,
				observation: first.details.observation,
				element_index: 1,
			}),
		).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(2);
	});
	it("maps reviewed right/double click, shortcut, focused typing and focus operations", async () => {
		const call = vi.fn(async () => ({ content: [], structuredContent: { snapshot_id: "s12345678" } }));
		const workflow = new ComputerWorkflow(
			{ call, close: async () => undefined },
			new DesktopLease(await directory()),
		);
		for (const [name, input, operation] of [
			["computer_click", { element_index: 1, button: "right" }, "right_click"],
			["computer_click", { element_index: 1, count: 2 }, "double_click"],
			["computer_key", { keys: ["ctrl", "c"] }, "hotkey"],
			["computer_text", { text: "hello" }, "type_text"],
			["computer_window", { action: "focus" }, "bring_to_front"],
			["computer_window", { action: "minimize", element_index: 2 }, "click"],
			["computer_window", { action: "restore", element_index: 3 }, "click"],
		] as const) {
			const observed = await workflow.execute("computer_observe", { pid: 1, window_id: 2 });
			await workflow.execute(name, { pid: 1, window_id: 2, observation: observed.details.observation, ...input });
			expect(call.mock.calls.at(-1)?.[0]).toBe(operation);
		}
		await workflow.close();
	});
	it("cancels a lost owner before admitting its next operation", async () => {
		const path = await directory();
		const lease = new DesktopLease(path);
		await lease.run(async () => undefined);
		await writeFile(
			join(path, "workflow-owner.json"),
			JSON.stringify({ pid: process.pid, identity: "replacement", processes: [] }),
		);
		const operation = vi.fn();
		await expect(lease.run(operation)).rejects.toThrow("lease lost");
		expect(lease.signal.aborted).toBe(true);
		expect(operation).not.toHaveBeenCalled();
		await lease.close();
	});
	it("closes with queued work without deadlocking or releasing before driver shutdown", async () => {
		const path = await directory();
		let stopped: (() => void) | undefined;
		const driverStopped = new Promise<void>((resolve) => {
			stopped = resolve;
		});
		const call = vi.fn(
			(_name, _args, signal: AbortSignal) =>
				new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
				),
		);
		const workflow = new ComputerWorkflow({ call, close: () => driverStopped }, new DesktopLease(path));
		const active = workflow.execute("computer_apps", {});
		const queued = workflow.execute("computer_apps", {});
		const settled = Promise.allSettled([active, queued]);
		await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
		const closing = workflow.close();
		const next = new DesktopLease(path);
		await expect(next.run(async () => undefined)).rejects.toThrow("busy");
		stopped?.();
		await closing;
		await settled;
		expect(call).toHaveBeenCalledTimes(1);
		await next.run(async () => undefined);
		await next.close();
	});
	it("holds a lease between calls, refuses competing owners, and serializes its owner", async () => {
		const path = await directory();
		const a = new DesktopLease(path),
			b = new DesktopLease(path);
		const order: number[] = [];
		await a.run(async () => {
			order.push(1);
		});
		await expect(b.run(async () => undefined)).rejects.toThrow("busy");
		await Promise.all([
			a.run(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				order.push(2);
			}),
			a.run(async () => {
				order.push(3);
			}),
		]);
		expect(order).toEqual([1, 2, 3]);
		await a.close();
		await b.run(async () => undefined);
		await b.close();
	});
	it("binds a single action to window and driver snapshot and invalidates it after input", async () => {
		const call = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "tree" }],
			structuredContent: { snapshot_id: "s12345678" },
		}));
		const close = vi.fn(async () => undefined);
		const workflow = new ComputerWorkflow({ call, close }, new DesktopLease(await directory()));
		const observed = await workflow.execute("computer_observe", { pid: 1, window_id: 2 });
		const action = { pid: 1, window_id: 2, observation: observed.details.observation, element_index: 3 };
		await workflow.execute("computer_click", action);
		expect(call).toHaveBeenLastCalledWith(
			"click",
			expect.objectContaining({ snapshot_id: "s12345678", delivery_mode: "background" }),
			expect.any(AbortSignal),
		);
		await expect(workflow.execute("computer_click", action)).rejects.toThrow("Stale observation");
		expect(call).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalled();
	});
	it("delivers screenshots as images and refuses coordinates outside their PNG dimensions", async () => {
		const bytes = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
		bytes.writeUInt32BE(100, 16);
		bytes.writeUInt32BE(50, 20);
		const call = vi.fn(async () => ({
			content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }],
			structuredContent: { snapshot_id: "s12345678" },
		}));
		const workflow = new ComputerWorkflow(
			{ call, close: async () => undefined },
			new DesktopLease(await directory()),
		);
		const observed = await workflow.execute("computer_observe", { pid: 1, window_id: 2, screenshot: true });
		expect(observed.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		await expect(
			workflow.execute("computer_click", {
				pid: 1,
				window_id: 2,
				observation: observed.details.observation,
				x: 100,
				y: 2,
			}),
		).rejects.toThrow("outside");
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("cancels a driver call that ignores its signal without waiting for its reply", async () => {
		const path = await directory();
		const call = vi.fn(() => new Promise<never>(() => undefined));
		const close = vi.fn(async () => undefined);
		const workflow = new ComputerWorkflow({ call, close }, new DesktopLease(path));
		const controller = new AbortController();
		const pending = workflow.execute("computer_apps", {}, controller.signal);
		const rejected = expect(pending).rejects.toThrow("never retry blindly");
		await vi.waitFor(() => expect(call).toHaveBeenCalled());
		controller.abort();
		await rejected;
		expect(close).toHaveBeenCalledTimes(1);
		const next = new DesktopLease(path);
		await next.run(async () => undefined);
		await next.close();
	});
	it("aborts input, closes the driver and permits a new owner only after cleanup", async () => {
		const path = await directory();
		const call = vi.fn(
			(_name, _args, signal?: AbortSignal) =>
				new Promise<never>((_resolve, reject) =>
					signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
				),
		);
		const workflow = new ComputerWorkflow({ call, close: async () => undefined }, new DesktopLease(path));
		const abort = new AbortController();
		const pending = workflow.execute("computer_apps", {}, abort.signal);
		await vi.waitFor(() => expect(call).toHaveBeenCalled());
		abort.abort();
		await expect(pending).rejects.toThrow("never retry blindly");
		const next = new DesktopLease(path);
		await next.run(async () => undefined);
		await next.close();
	});
});
