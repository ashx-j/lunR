import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChildExcludeTools } from "../src/builtin-extensions/pi-subagents/src/runs/shared/child-tools.ts";
import type { DriverReply } from "../src/core/computer-use/adapter.ts";
import { DesktopLease } from "../src/core/computer-use/lease.ts";
import { COMPUTER_TOOLS, computerRefusal } from "../src/core/computer-use/policy.ts";
import { computerSchemas } from "../src/core/computer-use/schemas.ts";
import { computerRelease } from "../src/core/computer-use/release.generated.ts";
import { ComputerWorkflow, driverData, driverRefused } from "../src/core/computer-use/workflow.ts";
import { createPermissionContext, deletePermissionContext, gateToolCall, registerApprovalHandler, resetPermissions } from "../src/core/permissions.ts";

vi.mock("../src/core/computer-use/image.ts", () => ({
	screenshotDimensions: () => ({ width: 2048, height: 1024 }),
	prepareComputerImage: async (image: { type: "image"; data: string; mimeType: string }, crop?: { x: number; y: number; width: number; height: number }) => {
		const region = crop ?? { x: 0, y: 0, width: 2048, height: 1024 };
		return { image, fingerprint: image.data, width: region.width / 2, height: region.height / 2,
			sourceWidth: 2048, sourceHeight: 1024, region, scaleX: 2, scaleY: 2 };
	},
}));

const paths: string[] = [];
async function directory() {
	const path = await mkdtemp(join(tmpdir(), "lunr-computer-test-"));
	paths.push(path);
	return path;
}
const target = { pid: 1, window_id: 2 };
function screenshot(data = "pixels", extra: Record<string, unknown> = {}): DriverReply {
	return { content: [{ type: "text", text: "SECRET RAW TREE" }, { type: "image", data, mimeType: "image/png" }],
		structuredContent: { screenshot_width: 2048, screenshot_height: 1024, tree: "SECRET AX", ...extra } };
}
async function fixture() {
	let pixels = "before";
	const call = vi.fn(async (name: string, _args: Record<string, unknown>, _signal?: AbortSignal): Promise<DriverReply> => {
		if (name === "get_window_state" || name === "get_desktop_state") return screenshot(pixels);
		pixels = "after";
		return { content: [], structuredContent: { effect: "unverifiable", secret: "NEVER FORWARD" } };
	});
	const close = vi.fn(async () => undefined);
	const workflow = new ComputerWorkflow({ call, close }, new DesktopLease(await directory()));
	return { workflow, call, close };
}
afterEach(async () => {
	vi.restoreAllMocks();
	resetPermissions();
	registerApprovalHandler(undefined);
	await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("computer policy and discovery", () => {
	it("isolates cron approvals and keeps read-only observation, mutation and release boundaries", async () => {
		resetPermissions("auto");
		const handler = vi.fn(async () => "session" as const);
		registerApprovalHandler(handler);
		createPermissionContext("cron-test", "read-only", false);
		expect(await gateToolCall("computer_observe", {}, ".", "cron-test")).toBeUndefined();
		expect(await gateToolCall("computer_click", {}, ".", "cron-test")).toMatchObject({ block: true });
		expect(handler).not.toHaveBeenCalled();
		deletePermissionContext("cron-test");
		registerApprovalHandler(undefined);
		resetPermissions("read-only");
		expect(await gateToolCall("computer_end", {}, ".")).toBeUndefined();
		expect(await gateToolCall("computer_observe", {}, ".")).toBeUndefined();
		expect(await gateToolCall("computer_click", {}, ".")).toMatchObject({ block: true });
		for (const mode of ["auto", "yolo", "read-only"] as const) {
			resetPermissions(mode);
			expect(await gateToolCall("computer_raw", {}, ".")).toMatchObject({ block: true });
		}
	});
	it("covers every native tool and excludes them from children", () => {
		expect(Object.keys(computerSchemas)).toEqual([...COMPUTER_TOOLS]);
		for (const permissions of ["full", "read-only"] as const)
			expect(resolveChildExcludeTools({ permissions })).toEqual(expect.arrayContaining([...COMPUTER_TOOLS]));
		for (const name of COMPUTER_TOOLS) {
			expect(computerRefusal(name, {}, { enabled: true, foreground: true, child: true, vision: true })).toContain("main agents");
			expect(computerSchemas[name].additionalProperties).toBe(false);
			expect(computerSchemas[name].properties).not.toHaveProperty("element_index");
			expect(computerSchemas[name].properties).not.toHaveProperty("snapshot_id");
			const properties = computerSchemas[name].properties;
			if ("observation" in properties) {
				expect(properties.observation.description).toContain("Copy the latest image token exactly");
				expect(properties.observation.description).toContain("Failed actions consume it");
			}
		}
		expect(computerSchemas.computer_apps.properties.offset).toMatchObject({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
		expect(computerSchemas.computer_observe.properties).not.toHaveProperty("screenshot");
		expect(computerSchemas.computer_click.required).toEqual(expect.arrayContaining(["x", "y", "observation"]));
		expect(computerSchemas.computer_window.properties).not.toHaveProperty("foreground");
	});
	it("requires vision for image-only tools while allowing release and enforcing foreground settings", () => {
		const policy = { enabled: true, foreground: true, child: false, vision: false };
		for (const name of COMPUTER_TOOLS.filter((name) => name !== "computer_end"))
			expect(computerRefusal(name, {}, policy)).toContain("image-capable");
		expect(computerRefusal("computer_end", {}, policy)).toBeUndefined();
		expect(computerRefusal("computer_observe", {}, { ...policy, enabled: false })).toContain("disabled");
		for (const name of ["computer_window", "computer_launch", "computer_click"])
			expect(computerRefusal(name, { desktop: true }, { ...policy, vision: true, foreground: false })).toContain("Foreground");
	});
});

async function rejectedData(pending: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await pending;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return JSON.parse(error.message);
	}
	throw new Error("Expected workflow rejection");
}

describe("image-only workflow", () => {
	it.each(["altered", "annotated", "expired", "pid", "window_id", "coordinate", "argument"])("reports %s validation as no input from this call", async (kind) => {
		const { workflow, call, close } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		const input: Record<string, unknown> = { ...target, observation: observed.details.observation, x: 1, y: 1 };
		if (kind === "altered") input.observation = "incorrect-token";
		if (kind === "annotated") input.observation = `${observed.details.observation} stale?`;
		if (kind === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30001);
		if (kind === "pid" || kind === "window_id") input[kind] = 9;
		if (kind === "coordinate") input.x = 9999;
		if (kind === "argument") input.element_index = 1;
		const data = await rejectedData(workflow.execute("computer_click", input));
		expect(data.input).toBe("not_dispatched");
		expect(data.code).toBe(kind === "expired" ? "observation_expired" : ["pid", "window_id"].includes(kind) ? "observation_target_mismatch" : ["altered", "annotated"].includes(kind) ? "observation_mismatch" : "invalid_arguments");
		expect(data.message).toContain("No input was sent by this call");
		expect(data.guidance).toContain("fresh capture");
		expect(data.guidance).toContain("including window focus");
		expect(JSON.stringify(data)).not.toContain("Input may have taken effect");
		expect(call).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("reports a missing active observation without inventing its cause", async () => {
		const { workflow, call } = await fixture();
		const data = await rejectedData(workflow.execute("computer_click", { ...target, observation: "unknown", x: 1, y: 1 }));
		expect(data).toMatchObject({ code: "observation_unavailable", input: "not_dispatched" });
		expect(call).not.toHaveBeenCalled();
	});
	it("keeps uncertainty after native dispatch throws and never forwards raw driver exception text", async () => {
		const { workflow, call, close } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		call.mockRejectedValueOnce(new Error("RAW SECRET TREE"));
		const data = await rejectedData(workflow.execute("computer_text", { ...target, observation: observed.details.observation, text: "fixture" }));
		expect(data).toMatchObject({ code: "input_dispatch_failed", input: "uncertain" });
		expect(data.message).toContain("Input may have taken effect");
		expect(JSON.stringify(data)).not.toContain("SECRET");
		expect(call).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("recovers from background_unavailable only with a fresh capture and exact foreground token", async () => {
		const first = await fixture();
		const observed = await first.workflow.execute("computer_observe", target);
		first.call.mockResolvedValueOnce({ isError: true, content: [], structuredContent: { code: "background_unavailable" } });
		const refusal = await first.workflow.execute("computer_text", { ...target, observation: observed.details.observation, text: "fixture" });
		const data = JSON.parse(refusal.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data.code).toBe("background_unavailable");
		expect(data.guidance).toContain("fresh capture");
		expect(data.guidance).toContain("foreground");
		expect(data.guidance).toContain("background shortcut");
		const consumed = await rejectedData(first.workflow.execute("computer_window", { ...target, observation: observed.details.observation, action: "focus" }));
		expect(consumed.input).toBe("not_dispatched");
		expect(consumed.guidance).toContain("does not prove foreground typing failed");
		expect(first.call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "type_text"]);
		const recovery = await fixture();
		const fresh = await recovery.workflow.execute("computer_observe", target);
		const result = await recovery.workflow.execute("computer_text", { ...target, observation: fresh.details.observation, foreground: true, text: "fixture" });
		expect(recovery.call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "type_text", "get_window_state"]);
		expect(recovery.call.mock.calls[1]?.[1]).toMatchObject({ ...target, delivery_mode: "foreground", text: "fixture" });
		expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
		await recovery.workflow.close();
	});
	it.each(["{\"accessibility_tree\":\"RAW SECRET", "RAW SECRET AX fragment"])("does not leak unparseable driver text: %s", async (text) => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text }] });
		const result = await workflow.execute("computer_click", { ...target, observation: observed.details.observation, x: 1, y: 1 });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("RAW SECRET");
		expect(JSON.stringify(result)).toContain("unverified");
	});
	it("requests image-only capture and returns one bounded metadata record plus image, never raw AX/JSON", async () => {
		const { workflow, call } = await fixture();
		const result = await workflow.execute("computer_observe", target);
		expect(call).toHaveBeenCalledWith("get_window_state", { ...target, include_accessibility_tree: false, include_screenshot: true, max_dimension: 2560 }, expect.any(AbortSignal));
		expect(result.content.map((item) => item.type)).toEqual(["text", "image"]);
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(result.details.observation).toBeTruthy();
		await workflow.close();
	});
	it("maps window coordinates and returns exactly one post-action image in the same call", async () => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		const result = await workflow.execute("computer_click", { ...target, observation: observed.details.observation, x: 512, y: 256, button: "right", count: 2, modifier: ["shift"] });
		expect(call.mock.calls[1]).toEqual(["click", { ...target, delivery_mode: "background", x: 1024, y: 512, button: "right", count: 2, modifier: ["shift"] }, expect.any(AbortSignal)]);
		expect(call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "click", "get_window_state"]);
		expect(JSON.stringify(result.content)).toContain("unverifiable");
		expect(JSON.stringify(result.content)).not.toContain("NEVER FORWARD");
		expect(result.content.filter((item) => item.type === "image")).toHaveLength(1);
		expect(result.details.observation).not.toBe(observed.details.observation);
		await workflow.close();
	});
	it("maps desktop pixels once, without applying native scale_factor a second time", async () => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot("desktop", { scale_factor: 2 }));
		const observed = await workflow.execute("computer_observe", { desktop: true });
		await workflow.execute("computer_click", { desktop: true, foreground: true, observation: observed.details.observation, x: 512, y: 256 });
		expect(call.mock.calls[1]).toEqual(["click", { scope: "desktop", delivery_mode: "foreground", x: 1024, y: 512 }, expect.any(AbortSignal)]);
		await workflow.close();
	});
	it.each([
		{ foreground: false, x: 1, y: 1 },
		{ foreground: true, pid: 1, x: 1, y: 1 },
	])("refuses conflicting or non-foreground desktop input before dispatch: %j", async (input) => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", { desktop: true });
		await expect(workflow.execute("computer_click", { desktop: true, observation: observed.details.observation, ...input })).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("requires a separate grounded click to change desktop keyboard focus", async () => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", { desktop: true });
		await expect(workflow.execute("computer_text", { desktop: true, foreground: true, observation: observed.details.observation, text: "hello", x: 1, y: 1 })).rejects.toThrow("separate grounded click");
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("captures a useful crop from fresh pixels and maps its local coordinates back to full capture pixels", async () => {
		const { workflow, call } = await fixture();
		const full = await workflow.execute("computer_observe", target);
		const cropped = await workflow.execute("computer_observe", { ...target, observation: full.details.observation, crop: { x: 100, y: 50, width: 200, height: 100 } });
		const text = cropped.content.find((item) => item.type === "text");
		expect(JSON.parse(text?.text ?? "{}").mapping).toMatchObject({ x: 200, y: 100, width: 400, height: 200, scaleX: 2, scaleY: 2 });
		await workflow.execute("computer_click", { ...target, observation: cropped.details.observation, x: 10, y: 20 });
		expect(call.mock.calls[2]?.[1]).toMatchObject({ x: 220, y: 140 });
		await workflow.close();
	});
	it("refuses a crop when native window geometry changed", async () => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot("a", { window_bounds: { x: 0, y: 0, width: 2048, height: 1024 } }))
			.mockResolvedValueOnce(screenshot("b", { window_bounds: { x: 10, y: 0, width: 2048, height: 1024 } }));
		const observed = await workflow.execute("computer_observe", target);
		await expect(workflow.execute("computer_observe", { ...target, observation: observed.details.observation, crop: { x: 1, y: 1, width: 20, height: 20 } })).rejects.toThrow("geometry changed");
	});
	it.each([{ element_index: 1 }, { snapshot_id: "old" }, { x: 1024, y: 1 }, { x: -1, y: 1 }])("rejects ungrounded input before dispatch: %j", async (input) => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		await expect(workflow.execute("computer_click", { ...target, observation: observed.details.observation, ...input })).rejects.toThrow();
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("consumes the image token and rejects replay even after successful post-action capture", async () => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		const input = { ...target, observation: observed.details.observation, x: 10, y: 20 };
		await workflow.execute("computer_click", input);
		await expect(workflow.execute("computer_click", input)).rejects.toThrow("Stale observation");
		expect(call).toHaveBeenCalledTimes(3);
	});
	it.each(["pid", "window_id"])("rejects a changed %s target", async (field) => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		await expect(workflow.execute("computer_click", { ...target, [field]: 9, observation: observed.details.observation, x: 1, y: 1 })).rejects.toThrow("Stale observation");
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("rejects an expired observation", async () => {
		const { workflow } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
		await expect(workflow.execute("computer_click", { ...target, observation: observed.details.observation, x: 1, y: 1 })).rejects.toThrow("Stale observation");
	});
	it.each([{ screenshot_frame_valid: false }, { screenshot_error: { code: "px_frame_mismatch" } }, { screenshot_width: 999 }])("refuses invalid native capture metadata: %j", async (extra) => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot("pixels", extra));
		await expect(workflow.execute("computer_observe", target)).rejects.toThrow("could not be verified");
	});
	it("preserves uncertainty and stops after a failed post-action capture without retrying input", async () => {
		const { workflow, call, close } = await fixture();
		call.mockResolvedValueOnce(screenshot()).mockResolvedValueOnce({ content: [], structuredContent: { effect: "partial" } }).mockRejectedValueOnce(new Error("capture unavailable"));
		const observed = await workflow.execute("computer_observe", target);
		const result = await workflow.execute("computer_click", { ...target, observation: observed.details.observation, x: 1, y: 1 });
		expect(result.isError).toBe(true);
		expect(result.details.observation).toBeUndefined();
		expect(JSON.stringify(result.content)).toContain("partial");
		expect(JSON.stringify(result.content)).toContain("Input may have taken effect");
		expect(JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}")).toMatchObject({ input: "dispatched", applicationEffect: "unverified", observation: "unavailable" });
		expect(call).toHaveBeenCalledTimes(3);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("keeps partial typing recovery and explicit uncertainty when the post-image fails", async () => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot()).mockResolvedValueOnce({ content: [], structuredContent: {
			effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2,
		} }).mockRejectedValueOnce(new Error("RAW SECRET capture error"));
		const observed = await workflow.execute("computer_observe", target);
		const result = await workflow.execute("computer_text", { ...target, observation: observed.details.observation, text: "A😀B" });
		const data = JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data).toMatchObject({ effect: "partial", requested_chars: 3, delivered_chars: 2, retry_from_character: 2, observation: "unavailable" });
		expect(data.guidance).toContain("Input may have taken effect");
		expect(data.guidance).toContain("Unicode code-point");
		expect(JSON.stringify(result)).not.toContain("RAW SECRET");
		expect(call).toHaveBeenCalledTimes(3);
	});
	it("retains the lease and no-dispatch reporting when cleanup cannot be confirmed", async () => {
		const path = await directory();
		const lease = new DesktopLease(path);
		const call = vi.fn(async () => screenshot());
		const close = vi.fn(async () => { throw new Error("shutdown failed"); });
		const workflow = new ComputerWorkflow({ call, close }, lease);
		const next = new DesktopLease(path);
		try {
			await workflow.execute("computer_observe", target);
			const data = await rejectedData(workflow.execute("computer_click", { ...target, observation: "bad", x: 1, y: 1 }));
			expect(data).toMatchObject({ input: "not_dispatched", code: "observation_mismatch", cleanup: "unconfirmed" });
			expect(call).toHaveBeenCalledTimes(1);
			await expect(next.run(async () => undefined)).rejects.toThrow("busy");
		} finally {
			await lease.close();
			await next.close();
		}
	});
	it("stops repeated unchanged polling and refuses an identical action after an unchanged result", async () => {
		const poll = await fixture();
		await poll.workflow.execute("computer_observe", target);
		await poll.workflow.execute("computer_observe", target);
		expect((await poll.workflow.execute("computer_observe", target)).isError).toBe(true);
		expect(poll.call).toHaveBeenCalledTimes(3);
		const action = await fixture();
		action.call.mockResolvedValue(screenshot());
		const before = await action.workflow.execute("computer_observe", target);
		const after = await action.workflow.execute("computer_click", { ...target, observation: before.details.observation, x: 1, y: 1 });
		await expect(action.workflow.execute("computer_click", { ...target, observation: after.details.observation, x: 1, y: 1 })).rejects.toThrow("identical action");
		expect(action.call).toHaveBeenCalledTimes(3);
	});
	it.each([
		[{}, { button: "left" }],
		[{}, { count: 1 }],
		[{}, { button: "left", count: 1, modifier: [] }],
		[{ button: "left", count: 1, modifier: [] }, {}],
		[{ modifier: ["shift", "ctrl"] }, { count: 1, modifier: ["ctrl", "shift"], button: "left" }],
	])("normalizes equivalent unchanged clicks before checking repetition: %j -> %j", async (first, repeated) => {
		const { workflow, call } = await fixture();
		call.mockResolvedValue(screenshot());
		const before = await workflow.execute("computer_observe", target);
		const after = await workflow.execute("computer_click", { ...target, observation: before.details.observation, x: 1, y: 1, ...first });
		await expect(workflow.execute("computer_click", { ...target, observation: after.details.observation, x: 1, y: 1, ...repeated })).rejects.toThrow("identical action");
		expect(call).toHaveBeenCalledTimes(3);
	});
	it.each([
		["computer_drag", { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }, "drag"],
		["computer_key", { keys: ["ctrl", "c"] }, "hotkey"],
		["computer_key", { key: "Enter" }, "press_key"],
		["computer_text", { text: "Unicode 日本語" }, "type_text"],
		["computer_scroll", { x: 5, y: 6, direction: "down", amount: 2, by: "line" }, "scroll"],
		["computer_window", { action: "focus" }, "bring_to_front"],
		["computer_window", { action: "frame", x: -10, y: 20, width: 600, height: 400 }, "set_window_frame"],
	] as const)("preserves one %s gesture and one post-image", async (name, input, operation) => {
		const { workflow, call } = await fixture();
		const observed = await workflow.execute("computer_observe", target);
		await workflow.execute(name, { ...target, observation: observed.details.observation, ...input });
		expect(call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", operation, "get_window_state"]);
		await workflow.close();
	});
	it("routes Windows foreground modifier shortcuts through pinned press_key SendInput instead of XAML hotkey UIA", async () => {
		expect(computerRelease.sourceCommit).toBe("d8028a7943087ee258dc1b4d19dc12a7cd27669c");
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const { workflow, call } = await fixture();
			const observed = await workflow.execute("computer_observe", target);
			await workflow.execute("computer_key", { ...target, observation: observed.details.observation, keys: ["ctrl", "a"], foreground: true });
			expect(call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "press_key", "get_window_state"]);
			expect(call.mock.calls[1]?.[1]).toEqual({ ...target, delivery_mode: "foreground", key: "a", modifiers: ["ctrl"] });
			await workflow.close();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});
	it.each(["apps", "windows"] as const)("retrieves omitted %s through bounded local pagination", async (kind) => {
		const { workflow, call } = await fixture();
		const rows = Array.from({ length: 101 }, (_, i) => ({ pid: i + 1, window_id: i + 1, name: `row-${i}`, secret: "SECRET" }));
		call.mockResolvedValue({ content: [], structuredContent: { [kind]: rows } });
		const selection = kind === "windows" ? { pid: 1 } : {};
		const first = await workflow.execute("computer_apps", selection);
		const readPage = (result: typeof first) => JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		const page1 = readPage(first);
		const page2 = readPage(await workflow.execute("computer_apps", { ...selection, offset: page1.next_offset }));
		const page3 = readPage(await workflow.execute("computer_apps", { ...selection, offset: page2.next_offset }));
		expect([page1.items.length, page2.items.length, page3.items.length]).toEqual([50, 50, 1]);
		expect([page1.next_offset, page2.next_offset, page3.next_offset]).toEqual([50, 100, undefined]);
		expect([...page1.items, ...page2.items, ...page3.items].map((row: { name: string }) => row.name)).toEqual(rows.map((row) => row.name));
		expect(page3.total).toBe(101);
		expect(JSON.stringify([page1, page2, page3])).not.toContain("SECRET");
		for (const [name, args] of call.mock.calls) {
			expect(name).toBe(kind === "windows" ? "list_windows" : "list_apps");
			expect(args).toEqual(selection);
		}
		expect(readPage(await workflow.execute("computer_apps", { ...selection, offset: 500 })).items).toEqual([]);
		await workflow.close();
	});
	it("finds a named app beyond the first page without returning unrelated identities", async () => {
		const { workflow, call } = await fixture();
		const rows = Array.from({ length: 139 }, (_, i) => ({ pid: 0, name: i === 117 ? "Notepad" : `app-${i}`, running: false, secret: "SECRET" }));
		call.mockResolvedValue({ content: [], structuredContent: { apps: rows } });
		const result = await workflow.execute("computer_apps", { query: "  nOtEpAd  " });
		const data = JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data).toMatchObject({ items: [{ pid: 0, name: "Notepad", running: false }], total: 1, offset: 0, query: "nOtEpAd" });
		expect(data.items).toHaveLength(1);
		expect(data.next_offset).toBeUndefined();
		expect(JSON.stringify(result)).not.toMatch(/SECRET|app-\d/);
		expect(call).toHaveBeenCalledExactlyOnceWith("list_apps", {}, expect.any(AbortSignal));
		await workflow.close();
	});
	it.each(["apps", "windows"] as const)("filters %s before pagination and display truncation, without matching hidden fields", async (kind) => {
		const { workflow, call } = await fixture();
		const rows = [...Array.from({ length: 103 }, (_, i) => i % 2 === 0
			? { pid: i + 1, window_id: i + 1, title: `${"x".repeat(240)} 日本語 [draft]`, secret: "SECRET" }
			: { pid: i + 1, name: "unrelated", secret: "日本語 [draft] SECRET" }),
			{ pid: 999, window_id: 999, app_name: "日本語 [draft]", secret: "SECRET" }];
		call.mockResolvedValue({ content: [], structuredContent: { [kind]: rows } });
		const selection = kind === "windows" ? { pid: 1 } : {};
		const readPage = async (input: Record<string, unknown>) => {
			const result = await workflow.execute("computer_apps", { ...selection, ...input });
			return JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		};
		const first = await readPage({ query: "日本語 [draft]" });
		const second = await readPage({ query: "日本語 [draft]", offset: first.next_offset });
		expect([first.items.length, second.items.length]).toEqual([50, 3]);
		expect(first).toMatchObject({ total: 53, omitted: 3, next_offset: 50 });
		expect(first.guidance).toContain("same pid and query");
		expect(second.next_offset).toBeUndefined();
		expect(first.items[0].title).toHaveLength(240);
		expect(second.items[2]).toMatchObject({ pid: 999, app_name: "日本語 [draft]" });
		expect(JSON.stringify([first, second])).not.toContain("SECRET");
		expect(await readPage({ query: "no match" })).toMatchObject({ items: [], total: 0 });
		expect(await readPage({ query: "日本語 [draft]", offset: 500 })).toMatchObject({ items: [], total: 53 });
		for (const [name, args] of call.mock.calls) {
			expect(name).toBe(kind === "windows" ? "list_windows" : "list_apps");
			expect(args).toEqual(selection);
		}
		await workflow.close();
	});
	it.each([121, 240])("accepts discovery queries with %i Unicode code points", async (length) => {
		const { workflow, call } = await fixture();
		const query = "\u{1F600}".repeat(length);
		call.mockResolvedValue({ content: [], structuredContent: { apps: [{ pid: 1, name: query }] } });
		const result = await workflow.execute("computer_apps", { query });
		const data = JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data).toMatchObject({ query, total: 1, items: [{ pid: 1 }] });
		expect(call).toHaveBeenCalledExactlyOnceWith("list_apps", {}, expect.any(AbortSignal));
		await workflow.close();
	});
	it.each([42, "", "   ", "x".repeat(241), "\u{1F600}".repeat(241)])("rejects invalid discovery query %j before native dispatch", async (query) => {
		const { workflow, call } = await fixture();
		const data = await rejectedData(workflow.execute("computer_apps", { query }));
		expect(data).toMatchObject({ input: "not_dispatched", code: "invalid_arguments" });
		expect(data.message).toContain("Discovery query");
		expect(call).not.toHaveBeenCalled();
	});
	it("preserves validated Unicode typing recovery without retrying or trusting completion", async () => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot()).mockResolvedValueOnce({
			isError: true, content: [{ type: "text", text: "RAW SECRET" }], structuredContent: {
				code: "type_text_incomplete", effect: "partial", path: "cgevent", requested_chars: 3,
				delivered_chars: 2, retryable: true, retry_from_character: 2, secret: "SECRET",
			},
		});
		const observed = await workflow.execute("computer_observe", target);
		const result = await workflow.execute("computer_text", { ...target, observation: observed.details.observation, text: "A😀B" });
		const data = JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data).toMatchObject({ effect: "partial", requested_chars: 3, delivered_chars: 2, retryable: true, retry_from_character: 2, applicationEffect: "unverified" });
		expect(data.guidance).toContain("Verify the field");
		expect(data.guidance).toContain("Unicode code-point");
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(result.isError).toBe(true);
		expect(call.mock.calls.map(([name]) => name)).toEqual(["get_window_state", "type_text"]);
	});
	it.each([
		{ requested_chars: 4 },
		{ requested_chars: -1 },
		{ requested_chars: 20001 },
		{ delivered_chars: -1 },
		{ delivered_chars: 4 },
		{ delivered_chars: 1.5 },
		{ delivered_chars: "2" },
		{ retry_from_character: 1 },
		{ retry_from_character: "2" },
	])("drops invalid typing recovery counts or offsets: %j", async (invalid) => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce(screenshot()).mockResolvedValueOnce({ isError: true, content: [], structuredContent: {
			code: "type_text_incomplete", effect: "partial", requested_chars: 3, delivered_chars: 2,
			retry_from_character: 2, retryable: "true", ...invalid,
		} });
		const observed = await workflow.execute("computer_observe", target);
		const result = await workflow.execute("computer_text", { ...target, observation: observed.details.observation, text: "A😀B" });
		const data = JSON.parse(result.content.find((item) => item.type === "text")?.text ?? "{}");
		expect(data).not.toHaveProperty("retry_from_character");
		expect(data).not.toHaveProperty("retryable");
		expect(data.applicationEffect).toBe("unverified");
		expect(call).toHaveBeenCalledTimes(2);
	});
	it("returns capped allowlisted app/window metadata and bounded nested refusal codes", async () => {
		const { workflow, call } = await fixture();
		call.mockResolvedValueOnce({ content: [{ type: "text", text: "RAW SECRET" }], structuredContent: { windows: Array.from({ length: 51 }, (_, i) => ({ window_id: i + 1, pid: 1, title: "a".repeat(1000), bounds: { x: 1, y: 2, width: 3, height: 4 }, tree: "SECRET" })) } });
		const result = await workflow.execute("computer_apps", { pid: 1 });
		const text = result.content.find((item) => item.type === "text");
		const data = JSON.parse(text?.text ?? "{}");
		expect(data.items).toHaveLength(50);
		expect(data.omitted).toBe(1);
		expect(data.items[0].title).toHaveLength(240);
		expect(JSON.stringify(result)).not.toContain("SECRET");
		call.mockResolvedValueOnce(screenshot()).mockResolvedValueOnce({ content: [], structuredContent: { refusal: { code: "background_uipi_blocked", raw_tree: "SECRET" }, escalation: { recommended: "foreground", suggestion: "SECRET" } } });
		const observed = await workflow.execute("computer_observe", target);
		const refused = await workflow.execute("computer_click", { ...target, observation: observed.details.observation, x: 1, y: 1 });
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("background_uipi_blocked");
		expect(JSON.stringify(refused.content)).not.toContain("SECRET");
	});
});

describe("driver outcome interpretation", () => {
	it("extracts one structured record and never treats uncertain replies as proof", () => {
		expect(driverData({ content: [{ type: "text", text: '{"status":"partial"}' }] }).status).toBe("partial");
		for (const data of [{ refusal: { code: "background_occluded" } }, { effect: "refused" }, { status: "failed" }, { code: "window_target_mismatch" }])
			expect(driverRefused({ content: [], structuredContent: data, isError: false })).toBe(true);
		expect(driverRefused({ content: [], isError: true, structuredContent: { success: true } })).toBe(true);
		expect(driverRefused({ content: [], structuredContent: { status: "partial", verified: false } })).toBe(false);
		expect(driverRefused({ content: [], structuredContent: { effect: "unverifiable" } })).toBe(false);
	});
});

describe("desktop ownership and cancellation", () => {
	it("locks runtime ownership updates and preserves the previous record on contention", async () => {
		const path = await directory();
		const lease = new DesktopLease(path);
		await lease.run(async () => undefined);
		const file = join(path, "workflow-owner.json");
		const before = await readFile(file, "utf8");
		const unlock = await lockfile.lock(path, { lockfilePath: join(path, "workflow-acquire.lock") });
		try {
			await expect(lease.trackProcess(4242)).rejects.toMatchObject({ code: "ELOCKED" });
			expect(await readFile(file, "utf8")).toBe(before);
		} finally { await unlock(); }
		await lease.trackProcess(4242);
		expect(JSON.parse(await readFile(file, "utf8")).processes).toEqual([4242]);
		await lease.close();
	});
	it("cancels a lost owner before admitting its next operation", async () => {
		const path = await directory();
		const lease = new DesktopLease(path);
		await lease.run(async () => undefined);
		await writeFile(join(path, "workflow-owner.json"), JSON.stringify({ pid: process.pid, identity: "replacement", processes: [] }));
		const operation = vi.fn();
		await expect(lease.run(operation)).rejects.toThrow("lease lost");
		expect(lease.signal.aborted).toBe(true);
		expect(operation).not.toHaveBeenCalled();
		await lease.close();
	});
	it("holds ownership between calls and serializes its owner", async () => {
		const path = await directory();
		const a = new DesktopLease(path), b = new DesktopLease(path);
		const order: number[] = [];
		await a.run(async () => { order.push(1); });
		await expect(b.run(async () => undefined)).rejects.toThrow("busy");
		await Promise.all([a.run(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push(2); }), a.run(async () => { order.push(3); })]);
		expect(order).toEqual([1, 2, 3]);
		await a.close();
		await b.run(async () => undefined);
		await b.close();
	});
	it("cancels a signal-ignoring call and releases only after confirmed driver shutdown", async () => {
		const path = await directory();
		let stopped: (() => void) | undefined;
		const driverStopped = new Promise<void>((resolve) => { stopped = resolve; });
		const call = vi.fn(() => new Promise<never>(() => undefined));
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
});
