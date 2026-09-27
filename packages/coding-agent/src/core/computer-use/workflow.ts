import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type ComputerDriver, DriverCallError, type DriverReply } from "./adapter.ts";
import { type ImageRegion, prepareComputerImage, screenshotDimensions } from "./image.ts";
import { DesktopLease } from "./lease.ts";
import { computerSchemas } from "./schemas.ts";

export function driverData(reply: DriverReply): Record<string, unknown> {
	if (reply.structuredContent && typeof reply.structuredContent === "object" && !Array.isArray(reply.structuredContent))
		return Object.fromEntries(Object.entries(reply.structuredContent));
	if (Array.isArray(reply.content)) for (const item of reply.content) {
		if (item.type !== "text" || typeof item.text !== "string") continue;
		try {
			const value: unknown = JSON.parse(item.text);
			if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
		} catch {}
	}
	return {};
}

function plainLaunchReason(reply: DriverReply): string | undefined {
	if (reply.structuredContent || !Array.isArray(reply.content)) return undefined;
	const text = reply.content.find((item) => item.type === "text")?.text;
	if (typeof text !== "string") return undefined;
	if (/^App name lookup for .+ is (?:temporarily unavailable|unavailable).+No app was launched;/s.test(text)) return "app_lookup_unavailable";
	if (/^App .+ was not found in shell:AppsFolder or by Windows PATH\/association lookup:/s.test(text)) return "app_not_found";
	if (/^Launch of .+ timed out after 15s/s.test(text)) return "launch_timeout_unknown";
	if (/^(?:Failed to launch|Task error): /s.test(text)) return "launch_native_error_unknown";
	return undefined;
}

export function driverRefused(reply: DriverReply): boolean {
	const data = driverData(reply);
	const acknowledged = data.activated === true || data.success === true || data.verified === true || data.effect === "confirmed";
	const uncertain = [data.status, data.effect].some((value) => value === "partial" || value === "unverifiable");
	return reply.isError === true || plainLaunchReason(reply) !== undefined ||
		(data.refusal !== undefined && data.refusal !== null && data.refusal !== false) ||
		(data.error !== undefined && data.error !== null && data.error !== false) ||
		data.effect === "refused" || data.status === "refused" || data.status === "failed" || data.success === false ||
		["window_target_mismatch", "window_target_not_found", "background_unavailable", "foreground_unavailable", "type_text_incomplete", "verification_failed"].includes(String(data.code)) ||
		(data.status !== undefined && !acknowledged && !uncertain && !["ok", "success", "completed"].includes(String(data.status))) ||
		(data.code !== undefined && data.code !== 0 && !acknowledged && !uncertain);
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function select(data: Record<string, unknown>, keys: readonly string[]): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const key of keys) {
		const value = data[key];
		if (["name", "app_name", "title"].includes(key) && typeof value === "string") result[key] = value.slice(0, 240);
		else if (["active", "running", "is_on_screen", "minimized"].includes(key) && typeof value === "boolean") result[key] = value;
		else if (["pid", "window_id", "x", "y", "width", "height"].includes(key) && typeof value === "number" && Number.isSafeInteger(value)) result[key] = value;
	}
	return result;
}

function typingRecovery(data: Record<string, unknown>, text: unknown) {
	if (typeof text !== "string") return {};
	const requested = data.requested_chars;
	const delivered = data.delivered_chars;
	if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 0 ||
		requested > 20000 || requested !== Array.from(text).length) return {};
	const validDelivered = typeof delivered === "number" && Number.isSafeInteger(delivered) && delivered >= 0 && delivered <= requested;
	return {
		requested_chars: requested,
		delivered_chars: validDelivered ? delivered : undefined,
		retryable: validDelivered && data.retry_from_character === delivered && typeof data.retryable === "boolean" ? data.retryable : undefined,
		retry_from_character: validDelivered && data.retry_from_character === delivered ? delivered : undefined,
	};
}

const nativeCodes = new Set(["background_unavailable", "background_occluded", "background_uipi_blocked", "window_target_mismatch", "window_target_not_found", "type_text_incomplete", "foreground_unavailable", "foreground_rejected", "stale_target", "target_not_found", "verification_failed", "tool_invocation_failed"]);
function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && nativeCodes.has(value) ? value : undefined;
}
function nativeReason(reply: DriverReply): string {
	const data = driverData(reply);
	const code = safeCode(data.code) ?? safeCode(record(data.refusal).code) ?? safeCode(record(data.error).code) ?? safeCode(data.refusal) ?? safeCode(data.error);
	if (code) return code;
	if (plainLaunchReason(reply)) return plainLaunchReason(reply)!;
	return "native_error_unknown";
}
type FailurePhase = "validation" | "adapter_preflight" | "native_request" | "native_result" | "observation_capture" | "post_action_capture" | "cleanup";
type InputState = "not_dispatched" | "dispatched" | "partial" | "uncertain";
type NativeOutcome = {
	phase: FailurePhase;
	code?: string;
	native_code?: string;
	status?: string;
	effect?: string;
	verified?: boolean;
	success?: boolean;
	activated?: boolean;
	escalation?: "foreground";
	input: InputState;
	applicationEffect: "unverified";
	requested_chars?: number;
	delivered_chars?: number;
	retryable?: boolean;
	retry_from_character?: number;
};
function outcome(reply: DriverReply, text?: unknown): NativeOutcome {
	const data = driverData(reply);
	const refused = driverRefused(reply);
	const partial = data.effect === "partial" || data.status === "partial";
	return {
		phase: refused || partial ? "native_result" : "native_request",
		code: refused || partial ? nativeReason(reply) : undefined,
		native_code: safeCode(data.code) ?? safeCode(record(data.refusal).code) ?? safeCode(record(data.error).code),
		status: typeof data.status === "string" && ["ok", "success", "completed", "partial", "refused", "failed"].includes(data.status) ? data.status : undefined,
		effect: typeof data.effect === "string" && ["confirmed", "partial", "unverifiable", "refused"].includes(data.effect) ? data.effect : undefined,
		verified: typeof data.verified === "boolean" ? data.verified : undefined,
		success: typeof data.success === "boolean" ? data.success : undefined,
		activated: typeof data.activated === "boolean" ? data.activated : undefined,
		escalation: record(data.escalation).recommended === "foreground" ? "foreground" : undefined,
		input: partial && typingRecovery(data, text).delivered_chars !== undefined ? "partial" : refused || partial ? "uncertain" : "dispatched",
		applicationEffect: "unverified",
		...typingRecovery(data, text),
	};
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason ?? new Error("Computer operation cancelled."));
		};
		signal.addEventListener("abort", abort, { once: true });
		pending.then((value) => {
			signal.removeEventListener("abort", abort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", abort);
			reject(error);
		});
		if (signal.aborted) abort();
	});
}

const freshActionGuidance = "Get a fresh capture of the exact target before any next action, including window focus. Copy its token exactly. No input was sent by this call; earlier calls may have had an effect.";

class CaptureError extends Error {
	readonly code: string;
	constructor(code: string) { super(code); this.code = code; }
}

class ObservationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`Stale observation. ${message}`);
		this.code = code;
	}
}

type Target = { desktop: true } | { pid: number; window_id: number; desktop?: false };
type PreparedImage = Awaited<ReturnType<typeof prepareComputerImage>>;
type Observation = PreparedImage & { token: string; target: Target; time: number; fingerprint: string; geometry: string };
type WorkflowState = "ready" | "stopped" | "cleanup_unconfirmed";
type Result = { content: (ImageContent | TextContent)[]; details: { observation?: string; computer: { failed: boolean; workflow: WorkflowState } }; isError: boolean };

function targetFrom(input: Record<string, unknown>): Target {
	if (input.desktop === true) {
		if (input.pid !== undefined || input.window_id !== undefined) throw new Error("Desktop target cannot include pid/window_id.");
		return { desktop: true };
	}
	if (typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid < 1 ||
		typeof input.window_id !== "number" || !Number.isInteger(input.window_id) || input.window_id < 1)
		throw new Error("Window target requires positive integer pid and window_id.");
	return { pid: input.pid, window_id: input.window_id };
}

function sameTarget(a: Target, b: Target): boolean {
	return a.desktop === true ? b.desktop === true : b.desktop !== true && a.pid === b.pid && a.window_id === b.window_id;
}

export class ComputerWorkflow {
	private observation?: Observation;
	private lastCapture?: { fingerprint: string; target: Target; repeats: number };
	private lastAction?: { signature: string; fingerprint: string; unchanged: boolean };
	private readonly abort = new AbortController();
	private closing?: Promise<void>;
	private readonly driver: ComputerDriver;
	private readonly lease: DesktopLease;
	constructor(driver: ComputerDriver, lease = new DesktopLease()) {
		this.driver = driver;
		this.lease = lease;
		this.driver.setProcessObserver?.((pid) => this.lease.trackProcess(pid));
	}

	private fresh(input: Record<string, unknown>, previous?: Observation): Observation {
		if (!previous) throw new ObservationError("observation_unavailable", "No active observation is available.");
		if (previous.token !== input.observation) throw new ObservationError("observation_mismatch", "Token does not match the active observation.");
		if (!sameTarget(previous.target, targetFrom(input))) throw new ObservationError("observation_target_mismatch", "Token belongs to a different target.");
		if (Date.now() - previous.time > 30000) throw new ObservationError("observation_expired", "The active observation is older than 30 seconds.");
		return previous;
	}

	private async capture(target: Target, signal: AbortSignal, previous?: Observation, crop?: ImageRegion): Promise<Observation> {
		const time = Date.now();
		const reply = await abortable(this.driver.call(target.desktop ? "get_desktop_state" : "get_window_state",
			target.desktop ? {} : { pid: target.pid, window_id: target.window_id, include_accessibility_tree: false, include_screenshot: true, max_dimension: 2560 }, signal), signal);
		if (driverRefused(reply)) throw new CaptureError(nativeReason(reply));
		const data = driverData(reply);
		const images = Array.isArray(reply.content) ? reply.content.filter((item) => item.type === "image") : [];
		if (images.length !== 1 || typeof images[0].data !== "string" || typeof images[0].mimeType !== "string")
			throw new CaptureError("screenshot_unavailable");
		const image: ImageContent = { type: "image", data: images[0].data, mimeType: images[0].mimeType };
		let dimensions: { width: number; height: number };
		try { dimensions = screenshotDimensions(image); } catch { throw new CaptureError("image_decode_failed"); }
		if (data.screenshot_frame_valid === false || data.screenshot_error != null || dimensions.width !== data.screenshot_width || dimensions.height !== data.screenshot_height)
			throw new CaptureError("image_frame_invalid");
		const geometry = JSON.stringify(select(record(data.window_bounds), ["x", "y", "width", "height"]));
		if (crop && previous && (previous.sourceWidth !== dimensions.width || previous.sourceHeight !== dimensions.height || previous.geometry !== geometry))
			throw new CaptureError("target_geometry_changed");
		let prepared: PreparedImage;
		try { prepared = await abortable(prepareComputerImage(image, crop), signal); }
		catch (error) { if (signal.aborted) throw error; throw new CaptureError("image_decode_failed"); }
		signal.throwIfAborted();
		return { ...prepared, token: randomUUID(), target, time, fingerprint: prepared.fingerprint, geometry };
	}

	private imageResult(observation: Observation, extra: Record<string, unknown> = {}): Result {
		this.observation = observation;
		const { width, height, region, sourceWidth, sourceHeight, scaleX, scaleY, target, token } = observation;
		const failed = extra.failed === true;
		return {
			content: [{ type: "text", text: JSON.stringify({
				...extra, observation: token, target, captured_at: observation.time, expires_at: observation.time + 30000, image: { width, height },
				mapping: { sourceWidth, sourceHeight, ...region, scaleX, scaleY },
				coordinates: "Use returned-image pixels; mapping is applied automatically.",
			}) }, observation.image],
			details: { observation: token, computer: { failed, workflow: "ready" } }, isError: failed,
		};
	}

	private crop(input: Record<string, unknown>, previous: Observation): ImageRegion {
		const crop = record(input.crop);
		const { x, y, width, height } = crop;
		if (typeof x !== "number" || typeof y !== "number" || typeof width !== "number" || typeof height !== "number" ||
			![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
			x + width > previous.width || y + height > previous.height || Object.keys(crop).some((key) => !["x", "y", "width", "height"].includes(key)))
			throw new Error("Crop must fit the latest returned image.");
		const left = Math.floor(previous.region.x + x * previous.scaleX);
		const top = Math.floor(previous.region.y + y * previous.scaleY);
		const right = Math.min(previous.sourceWidth, Math.ceil(previous.region.x + (x + width) * previous.scaleX));
		const bottom = Math.min(previous.sourceHeight, Math.ceil(previous.region.y + (y + height) * previous.scaleY));
		return { x: left, y: top, width: right - left, height: bottom - top };
	}

	private action(name: string, input: Record<string, unknown>, previous: Observation) {
		const args: Record<string, unknown> = previous.target.desktop ? { scope: "desktop" } : { pid: previous.target.pid, window_id: previous.target.window_id };
		if (previous.target.desktop && input.foreground !== true) throw new Error("Desktop input requires foreground=true.");
		if (name !== "computer_window" && name !== "computer_hover") args.delivery_mode = input.foreground === true ? "foreground" : "background";
		for (const key of ["x", "y", "from_x", "from_y", "to_x", "to_y"]) {
			if (name === "computer_window") break;
			const value = input[key];
			if (value === undefined) continue;
			const horizontal = key.endsWith("x");
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= (horizontal ? previous.width : previous.height))
				throw new Error("Coordinate outside the observed image.");
			args[key] = (horizontal ? previous.region.x : previous.region.y) + value * (horizontal ? previous.scaleX : previous.scaleY);
		}
		if ((input.x === undefined) !== (input.y === undefined)) throw new Error("Provide a complete x/y pair.");
		if (previous.target.desktop && ["computer_key", "computer_text"].includes(name) && input.x !== undefined)
			throw new Error("Desktop keyboard input uses the observed focused field. Change focus with a separate grounded click.");
		let operation: string;
		switch (name) {
			case "computer_hover":
				if (process.platform !== "win32" || !previous.target.desktop || input.desktop !== true || input.foreground !== true ||
					input.x === undefined || input.y === undefined) throw new Error("Hover requires a Windows foreground desktop image and x/y coordinates.");
				operation = "move_cursor";
				break;
			case "computer_click":
			case "computer_scroll":
				if (input.x === undefined || input.y === undefined) throw new Error("This action requires x/y image coordinates.");
				operation = name === "computer_click" ? "click" : "scroll";
				for (const key of name === "computer_click" ? ["button", "count", "modifier"] : ["direction", "amount", "by"])
					if (input[key] !== undefined) args[key] = input[key];
				break;
			case "computer_drag":
				if (!["from_x", "from_y", "to_x", "to_y"].every((key) => typeof args[key] === "number")) throw new Error("Drag requires both endpoints.");
				operation = "drag";
				break;
			case "computer_key": {
				if ((input.key === undefined) === (input.keys === undefined)) throw new Error("Provide key OR keys.");
				const keys: readonly unknown[] | undefined = Array.isArray(input.keys) ? input.keys : undefined;
				const last = keys?.at(-1);
				const modifiers = new Set(["ctrl", "control", "shift", "alt", "win", "windows", "cmd", "command"]);
				const foregroundShortcut = process.platform === "win32" && input.foreground === true && input.x === undefined &&
					keys !== undefined && keys.length >= 2 && keys.slice(0, -1).every((key) => typeof key === "string" && modifiers.has(key.toLowerCase())) &&
					typeof last === "string" && !modifiers.has(last.toLowerCase());
				// Pinned Windows hotkey routes XAML through UIA before honoring foreground; press_key honors SendInput.
				operation = input.keys === undefined || foregroundShortcut ? "press_key" : "hotkey";
				if (foregroundShortcut) {
					args.key = last;
					args.modifiers = keys.slice(0, -1);
				} else args[input.keys === undefined ? "key" : "keys"] = input.keys ?? input.key;
				break;
			}
			case "computer_text":
				operation = "type_text";
				args.text = input.text;
				break;
			case "computer_window":
				if (previous.target.desktop) throw new Error("Window management requires an exact window target.");
				if (input.action === "frame") {
					for (const key of ["x", "y", "width", "height"]) {
						const value = input[key];
						if (typeof value !== "number" || !Number.isFinite(value) || (["width", "height"].includes(key) && value <= 0)) throw new Error("Frame requires valid x/y/width/height.");
						args[key] = value;
					}
					operation = "set_window_frame";
				} else if (input.action === "focus" && ["x", "y", "width", "height"].every((key) => input[key] === undefined)) operation = "bring_to_front";
				else throw new Error("Use frame or focus. Minimize/restore uses a fresh image click on the visible control.");
				break;
			default: throw new Error("Unknown computer action.");
		}
		return { operation, args };
	}

	async execute(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
		const combined = AbortSignal.any([this.abort.signal, this.lease.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
		let inputDispatched = false;
		let failureCode = "workflow_unavailable";
		let phase: FailurePhase = "validation";
		const currentPhase = (): FailurePhase => phase;
		let operationName = name;
		let actionTarget: Target | undefined;
		let actionOutcome: ReturnType<typeof outcome> | undefined;
		try {
			const result = await this.lease.run(async (): Promise<Result> => {
				failureCode = "invalid_arguments";
				const previous = this.observation;
				if (name !== "computer_apps") this.observation = undefined;
				if (!Object.hasOwn(computerSchemas, name)) throw new Error("Unknown computer operation.");
				const schema = computerSchemas[name as keyof typeof computerSchemas];
				if (Object.keys(input).some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Unsupported computer argument. Use image coordinates only.");
				if (name === "computer_apps" || name === "computer_launch") {
					const operation = name === "computer_launch" ? "launch_app" : input.pid === undefined ? "list_apps" : "list_windows";
					operationName = operation;
					if (input.include_windows !== undefined && (name !== "computer_apps" || typeof input.include_windows !== "boolean" || (input.include_windows && (input.pid !== undefined || typeof input.query !== "string" || !input.query.trim()))))
						throw new Error("include_windows requires a named app query without pid.");
					if (input.pid !== undefined && (typeof input.pid !== "number" || !Number.isSafeInteger(input.pid) || input.pid < 1)) throw new Error("Window lookup requires a positive pid.");
					if (name === "computer_launch" && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 500)) throw new Error("Launch requires a nonblank name.");
					if (input.query !== undefined && (typeof input.query !== "string" || !input.query.trim() || Array.from(input.query).length > 240))
						throw new Error("Discovery query must be a nonblank string of at most 240 characters.");
					const query = typeof input.query === "string" ? input.query.trim() : undefined;
					const needle = query?.toLowerCase();
					const offset = input.offset ?? 0;
					if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
						throw new Error("Discovery offset must be a nonnegative safe integer.");
					const args = name === "computer_launch" ? { name: input.name } : input.pid === undefined ? {} : { pid: input.pid };
					combined.throwIfAborted();
					inputDispatched = name === "computer_launch";
					phase = "native_request";
					failureCode = "discovery_failed";
					const reply = await abortable(this.driver.call(operation, args, combined), combined);
					const data = driverData(reply);
					const discovered = data.apps ?? data.windows;
					const rows = Array.isArray(discovered) && needle ? discovered.filter((row) => {
						const item = record(row);
						return [item.name, item.app_name, item.title].some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
					}) : discovered;
					const metadata = Array.isArray(rows) ? rows.slice(offset, offset + 50).map((row) => {
						const item = record(row);
						return { ...select(item, ["pid", "window_id", "name", "app_name", "title", "active", "running", "is_on_screen", "minimized"]),
							bounds: item.bounds ? select(record(item.bounds), ["x", "y", "width", "height"]) : undefined };
					}) : undefined;
					const remaining = Array.isArray(rows) ? Math.max(0, rows.length - offset - (metadata?.length ?? 0)) : 0;
					const failed = driverRefused(reply);
					const pid = typeof data.pid === "number" && Number.isSafeInteger(data.pid) && data.pid > 0 ? data.pid : undefined;
					const launchWindows = Array.isArray(data.windows) ? data.windows.slice(0, 50).map((row) => {
						const item = record(row);
						return { ...select(item, ["window_id", "title", "is_on_screen", "minimized"]), bounds: item.bounds ? select(record(item.bounds), ["x", "y", "width", "height"]) : undefined };
					}) : [];
					const returnedId = data.window_id ?? (Array.isArray(data.windows) && data.windows.length === 1 ? record(data.windows[0]).window_id : undefined);
					const windowId = typeof returnedId === "number" && Number.isSafeInteger(returnedId) && returnedId > 0 ? returnedId : undefined;
					let windowsByPid: { pid: number; windows?: typeof metadata; error?: string; omitted?: number; next_offset?: number }[] | undefined;
					let guidance = remaining ? "Pass next_offset as offset with the same pid and query. Lists refresh per call." : input.pid !== undefined
						? "Use computer_observe({pid,window_id}) for an exact returned window."
						: "App query filters app identities, not every window title. Use computer_apps({pid}) to find windows for a running app.";
					if (name === "computer_apps" && input.include_windows === true && !failed) {
						const pids = [...new Set((Array.isArray(rows) ? rows : []).map((row) => record(row).pid).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0))];
						if (pids.length > 5) guidance = "More than five running processes matched. Narrow the query or choose one positive pid with computer_apps({pid}); no arbitrary process was selected.";
						else {
							windowsByPid = [];
							let budget = 50;
							for (const matchingPid of pids) {
								combined.throwIfAborted();
								try {
									const windowsReply = await abortable(this.driver.call("list_windows", { pid: matchingPid }, combined), combined);
									const windows = driverData(windowsReply).windows;
									if (driverRefused(windowsReply) || !Array.isArray(windows)) { windowsByPid.push({ pid: matchingPid, error: driverRefused(windowsReply) ? nativeReason(windowsReply) : "windows_unavailable" }); continue; }
									const subset = windows.slice(0, budget).map((row) => {
										const item = record(row);
										return { ...select(item, ["pid", "window_id", "name", "app_name", "title", "active", "running", "is_on_screen", "minimized"]),
											bounds: item.bounds ? select(record(item.bounds), ["x", "y", "width", "height"]) : undefined };
									});
									const omitted = windows.length - subset.length;
									windowsByPid.push({ pid: matchingPid, windows: subset, omitted: omitted || undefined, next_offset: omitted ? subset.length : undefined });
									budget -= subset.length;
								} catch (error) {
									if (combined.aborted) throw error;
									if (error instanceof DriverCallError) throw error;
									windowsByPid.push({ pid: matchingPid, error: "window_lookup_failed" });
								}
							}
							guidance = "Use computer_observe({pid,window_id}) for a returned window. For omitted windows use computer_apps({pid,offset:next_offset}). Per-PID failures need a targeted lookup.";
						}
					}
					if (name === "computer_launch") guidance = pid && windowId && !failed
						? `Use computer_observe({pid:${pid},window_id:${windowId}}) before input.`
						: `Launch ${failed ? "may have completed despite an unsuccessful reply" : "returned no exact window"}. Use computer_apps({${pid ? `pid:${pid}` : `query:${JSON.stringify(input.name)}`}}) before another launch or input.`;
					return { content: [{ type: "text", text: JSON.stringify({
						kind: name === "computer_launch" ? "launch" : input.pid === undefined ? "apps" : "windows", operation,
						...(name === "computer_launch" ? outcome(reply) : { phase: "native_result", code: failed ? nativeReason(reply) : undefined }),
						input: name === "computer_launch" ? "not_applicable" : undefined,
						launch: name === "computer_launch" ? plainLaunchReason(reply) === "app_lookup_unavailable" ? "not_started" : failed ? "completion_uncertain" : "acknowledged" : undefined,
						...select(data, ["pid", "window_id", "name", "title"]), window_id: name === "computer_launch" ? windowId : select(data, ["window_id"]).window_id,
						windows: name === "computer_launch" ? launchWindows : undefined, items: name === "computer_launch" ? undefined : metadata,
						windows_by_pid: windowsByPid, query, offset, total: Array.isArray(rows) ? rows.length : undefined,
						omitted: remaining || undefined, next_offset: remaining ? offset + 50 : undefined, guidance,
					}) }], details: { computer: { failed, workflow: "ready" } }, isError: failed };
				}
				const target = targetFrom(input);
				actionTarget = target;
				if (name === "computer_observe") {
					phase = "observation_capture";
					const crop = input.crop === undefined ? undefined : this.crop(input, this.fresh(input, previous));
					failureCode = "capture_failed";
					const captured = await this.capture(target, combined, previous, crop);
					const unchanged = this.lastCapture?.fingerprint === captured.fingerprint && sameTarget(this.lastCapture.target, target);
					const repeats = crop ? 0 : unchanged ? (this.lastCapture?.repeats ?? 0) + 1 : 1;
					this.lastCapture = { fingerprint: captured.fingerprint, target, repeats };
					if (repeats >= 3) return {
						content: [{ type: "text", text: JSON.stringify({ phase: "observation_capture", code: "unchanged_polling_limit", guidance: "Three captures are unchanged. Stop polling and reconsider the target or approach. No input token issued." }) }],
						details: { computer: { failed: true, workflow: "stopped" } }, isError: true,
					};
					return this.imageResult(captured, { unchanged });
				}
				const grounded = this.fresh(input, previous);
				const { operation, args } = this.action(name, input, grounded);
				const { button = "left", count = 1, modifier = [], ...clickArgs } = args;
				const signature = JSON.stringify({ operation, args: operation === "click"
					? { ...clickArgs, button, count, modifier: Array.isArray(modifier) ? [...new Set(modifier)].sort() : modifier }
					: args });
				if (this.lastAction?.unchanged && this.lastAction.signature === signature && this.lastAction.fingerprint === grounded.fingerprint)
					throw new Error("The identical action had no visible change. Choose a different grounded action; never retry blindly.");
				combined.throwIfAborted();
				inputDispatched = true;
				phase = "native_request";
				operationName = operation;
				const reply = await abortable(this.driver.call(operation, args, combined), combined);
				combined.throwIfAborted();
				actionOutcome = outcome(reply, name === "computer_text" ? input.text : undefined);
				const recoveryGuidance = actionOutcome.retry_from_character !== undefined
					? "Verify the field in a fresh image before considering any remaining suffix. retry_from_character is a zero-based Unicode code-point offset, not UTF-16. retryable is driver advice, not authorization to retry."
					: undefined;
				const failed = driverRefused(reply) || driverData(reply).effect === "partial" || driverData(reply).status === "partial";
				const backgroundUnavailable = actionOutcome.code === "background_unavailable";
				if (name === "computer_hover") await delay(700, undefined, { signal: combined });
				phase = "post_action_capture";
				try {
					const after = await this.capture(target, combined);
					const unchanged = after.fingerprint === grounded.fingerprint;
					this.lastAction = { signature, fingerprint: after.fingerprint, unchanged };
					this.lastCapture = { fingerprint: after.fingerprint, target, repeats: failed && this.lastCapture?.fingerprint === after.fingerprint && sameTarget(this.lastCapture.target, target)
						? this.lastCapture.repeats : 0 };
					return this.imageResult(after, { kind: "action", operation, target, ...actionOutcome, failed, unchanged,
						guidance: ["Inspect the post-action image before another action. No visible change does not prove failure; never repeat blindly.",
							backgroundUnavailable ? "After this fresh capture, foreground input may be considered if permitted, not another background shortcut." : undefined,
							recoveryGuidance].filter(Boolean).join(" ") });
				} catch (error) {
					combined.throwIfAborted();
					if (!(error instanceof CaptureError)) throw error;
					this.lastAction = { signature, fingerprint: grounded.fingerprint, unchanged: true };
					return { content: [{ type: "text", text: JSON.stringify({ kind: "action", operation, target, ...actionOutcome, phase: "post_action_capture",
						capture_error: error.code, observation: "unavailable", guidance: `Input may have taken effect. ${["target_not_found", "window_target_not_found", "window_target_mismatch"].includes(error.code)
							? "Use computer_apps({pid}) or observe the desktop to find the target." : "Get a fresh capture of the exact target"} before another action; never repeat blindly. ${recoveryGuidance ?? ""}`,
					}) }], details: { computer: { failed: true, workflow: "ready" } }, isError: true };
				}
			}, combined);
			if (result.details.computer.workflow !== "ready") return this.finish(result);
			return result;
		} catch (error) {
			if (error instanceof DriverCallError && !(currentPhase() === "post_action_capture" && actionOutcome)) {
				phase = error.phase;
				inputDispatched = error.dispatched;
			}
			const failurePhase = currentPhase();
			const fatal = combined.aborted || this.abort.signal.aborted || this.lease.signal.aborted || error instanceof DriverCallError ||
				!(error instanceof ObservationError || error instanceof CaptureError || failurePhase === "validation" || failurePhase === "observation_capture" && !inputDispatched);
			const code = error instanceof ObservationError || error instanceof CaptureError ? error.code
				: inputDispatched && failurePhase === "post_action_capture" ? "capture_transport_failed"
				: error instanceof DriverCallError ? error.dispatched ? "input_dispatch_failed" : "adapter_preflight_failed"
				: inputDispatched ? "input_dispatch_failed" : failurePhase === "validation" ? "invalid_arguments" : failureCode;
			const message = name === "computer_launch" ? inputDispatched ? "Launch request began; activation may have occurred." : "No launch request was sent by this call."
				: inputDispatched ? "Input may have taken effect; request began." : "No input was sent by this call.";
			const guidance = inputDispatched ? name === "computer_launch"
				? `Use computer_apps({query:${JSON.stringify(input.name)}) before considering another launch.`
				: `Get a fresh capture of the exact target before another action. Input may have taken effect; inspect the field before deciding and never repeat blindly. ${actionOutcome?.retry_from_character !== undefined ? "Verify the field in a fresh image before considering any remaining suffix. retry_from_character is a zero-based Unicode code-point offset, not UTF-16." : ""}`
				: freshActionGuidance;
			const result: Result = { content: [{ type: "text", text: JSON.stringify({ kind: name === "computer_apps" ? "apps" : name === "computer_launch" ? "launch" : name === "computer_observe" ? "observation" : "action",
				operation: operationName, target: actionTarget, ...actionOutcome, action_outcome: actionOutcome, phase: failurePhase, code,
				input: name === "computer_apps" ? undefined : name === "computer_launch" ? "not_applicable" : inputDispatched ? "uncertain" : "not_dispatched",
				request: name === "computer_launch" ? inputDispatched ? "sent" : "not_sent" : undefined, applicationEffect: "unverified",
				observation: "unavailable", capture_error: failurePhase === "post_action_capture" ? code : undefined, message, guidance }) }], details: { computer: { failed: true, workflow: fatal ? "stopped" : "ready" } }, isError: true };
			return fatal ? this.finish(result) : result;
		}
	}

	private async finish(result: Result): Promise<Result> {
		try {
			await this.close();
			return { ...result, details: { ...result.details, computer: { failed: result.details.computer.failed, workflow: "stopped" } } };
		} catch {
			return { content: [...result.content, { type: "text", text: JSON.stringify({ phase: "cleanup", cleanup: "unconfirmed", guidance: "Desktop ownership retained until shutdown is confirmed." }) }],
				details: { ...result.details, computer: { failed: true, workflow: "cleanup_unconfirmed" } }, isError: true };
		}
	}

	close(): Promise<void> {
		this.abort.abort();
		this.observation = undefined;
		this.closing ??= this.stop();
		return this.closing;
	}

	private async stop(): Promise<void> {
		await this.driver.close();
		await this.lease.close();
	}
}
