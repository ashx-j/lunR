import { createHash, randomUUID } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ComputerDriver, DriverReply } from "./adapter.ts";
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

export function driverRefused(reply: DriverReply): boolean {
	const data = driverData(reply);
	const acknowledged = data.activated === true || data.success === true || data.verified === true || data.effect === "confirmed";
	const uncertain = [data.status, data.effect].some((value) => value === "partial" || value === "unverifiable");
	return reply.isError === true ||
		(data.refusal !== undefined && data.refusal !== null && data.refusal !== false) ||
		(data.error !== undefined && data.error !== null && data.error !== false) ||
		data.effect === "refused" || data.status === "refused" || data.status === "failed" || data.success === false ||
		data.code === "window_target_mismatch" ||
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
		if (typeof value === "string") result[key] = value.slice(0, 240);
		else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
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
		retryable: typeof data.retryable === "boolean" ? data.retryable : undefined,
		retry_from_character: validDelivered && data.retry_from_character === delivered ? delivered : undefined,
	};
}

function outcome(reply: DriverReply, text?: unknown) {
	const data = driverData(reply);
	const message = Array.isArray(reply.content) ? reply.content.find((item) => item.type === "text" && typeof item.text === "string") : undefined;
	return {
		...select(data, ["status", "effect", "refusal", "error", "code", "path", "verified", "verify", "success", "activated"]),
		refusal: typeof data.refusal === "object" && data.refusal !== null ? select(record(data.refusal), ["code", "message", "facility"]) : select(data, ["refusal"]).refusal,
		error: typeof data.error === "object" && data.error !== null ? select(record(data.error), ["code", "message", "facility"]) : select(data, ["error"]).error,
		message: Object.keys(data).length === 0 && message?.type === "text" ? String(message.text).slice(0, 240) : undefined,
		escalation: record(data.escalation).recommended === "foreground" ? "foreground" : undefined,
		input: driverRefused(reply) ? "refused_or_failed" : "dispatched",
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

type Target = { desktop: true } | { pid: number; window_id: number; desktop?: false };
type PreparedImage = Awaited<ReturnType<typeof prepareComputerImage>>;
type Observation = PreparedImage & { token: string; target: Target; time: number; fingerprint: string; geometry: string };
type Result = { content: (ImageContent | TextContent)[]; details: { observation?: string }; isError: boolean };

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
		if (!previous || previous.token !== input.observation || !sameTarget(previous.target, targetFrom(input)) ||
			Date.now() - previous.time > 30000)
			throw new Error("Stale observation. Capture this exact target again before acting.");
		return previous;
	}

	private async capture(target: Target, signal: AbortSignal, previous?: Observation, crop?: ImageRegion): Promise<Observation> {
		const time = Date.now();
		const reply = await abortable(this.driver.call(target.desktop ? "get_desktop_state" : "get_window_state",
			target.desktop ? {} : { pid: target.pid, window_id: target.window_id, include_accessibility_tree: false, include_screenshot: true, max_dimension: 2560 }, signal), signal);
		if (driverRefused(reply)) throw new Error(`Capture refused: ${JSON.stringify(outcome(reply))}`);
		const data = driverData(reply);
		const images = Array.isArray(reply.content) ? reply.content.filter((item) => item.type === "image") : [];
		if (images.length !== 1 || typeof images[0].data !== "string" || typeof images[0].mimeType !== "string")
			throw new Error("Capture must return exactly one screenshot.");
		const image: ImageContent = { type: "image", data: images[0].data, mimeType: images[0].mimeType };
		const dimensions = screenshotDimensions(image);
		if (data.screenshot_frame_valid === false || data.screenshot_error != null || dimensions.width !== data.screenshot_width || dimensions.height !== data.screenshot_height)
			throw new Error("Screenshot dimensions or frame could not be verified. Capture again.");
		const geometry = JSON.stringify(select(record(data.window_bounds), ["x", "y", "width", "height"]));
		if (crop && previous && (previous.sourceWidth !== dimensions.width || previous.sourceHeight !== dimensions.height || previous.geometry !== geometry))
			throw new Error("Target geometry changed. Capture a full image before selecting a crop.");
		const prepared = await abortable(prepareComputerImage(image, crop), signal);
		signal.throwIfAborted();
		return { ...prepared, token: randomUUID(), target, time, geometry,
			fingerprint: createHash("sha256").update(image.data).digest("hex") };
	}

	private imageResult(observation: Observation, extra: Record<string, unknown> = {}): Result {
		this.observation = observation;
		const { width, height, region, sourceWidth, sourceHeight, scaleX, scaleY, target, token } = observation;
		return {
			content: [{ type: "text", text: JSON.stringify({
				...extra, observation: token, target, image: { width, height },
				mapping: { sourceWidth, sourceHeight, ...region, scaleX, scaleY },
				coordinates: "Use returned-image pixels; mapping is applied automatically.",
			}) }, observation.image],
			details: { observation: token }, isError: false,
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
		if (name !== "computer_window") args.delivery_mode = input.foreground === true ? "foreground" : "background";
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
			case "computer_key":
				if ((input.key === undefined) === (input.keys === undefined)) throw new Error("Provide key OR keys.");
				operation = input.keys === undefined ? "press_key" : "hotkey";
				args[input.keys === undefined ? "key" : "keys"] = input.keys ?? input.key;
				break;
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
		try {
			const result = await this.lease.run(async (): Promise<Result> => {
				if (!Object.hasOwn(computerSchemas, name)) throw new Error("Unknown computer operation.");
				const schema = computerSchemas[name as keyof typeof computerSchemas];
				if (Object.keys(input).some((key) => !Object.hasOwn(schema.properties, key))) throw new Error("Unsupported computer argument. Use image coordinates only.");
				const previous = this.observation;
				this.observation = undefined;
				if (name === "computer_apps" || name === "computer_launch") {
					const operation = name === "computer_launch" ? "launch_app" : input.pid === undefined ? "list_apps" : "list_windows";
					const offset = input.offset ?? 0;
					if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
						throw new Error("Discovery offset must be a nonnegative safe integer.");
					const args = name === "computer_launch" ? { name: input.name } : input.pid === undefined ? {} : { pid: input.pid };
					const reply = await abortable(this.driver.call(operation, args, combined), combined);
					const data = driverData(reply);
					const rows = data.apps ?? data.windows;
					const metadata = Array.isArray(rows) ? rows.slice(offset, offset + 50).map((row) => {
						const item = record(row);
						return { ...select(item, ["pid", "window_id", "name", "app_name", "title", "active", "running", "is_on_screen", "minimized"]),
							bounds: item.bounds ? select(record(item.bounds), ["x", "y", "width", "height"]) : undefined };
					}) : undefined;
					const remaining = Array.isArray(rows) ? Math.max(0, rows.length - offset - (metadata?.length ?? 0)) : 0;
					return { content: [{ type: "text", text: JSON.stringify({
						...outcome(reply), ...select(data, ["pid", "window_id", "name", "title"]),
						items: metadata, offset, total: Array.isArray(rows) ? rows.length : undefined,
						omitted: remaining || undefined, next_offset: remaining ? offset + 50 : undefined,
						guidance: name === "computer_launch" ? "Capture the exact target before input." : remaining ? "Pass next_offset as offset with the same pid selection. Lists refresh per call." : undefined,
					}) }], details: {}, isError: driverRefused(reply) };
				}
				const target = targetFrom(input);
				if (name === "computer_observe") {
					const crop = input.crop === undefined ? undefined : this.crop(input, this.fresh(input, previous));
					const captured = await this.capture(target, combined, previous, crop);
					const unchanged = this.lastCapture?.fingerprint === captured.fingerprint && sameTarget(this.lastCapture.target, target);
					const repeats = crop ? 0 : unchanged ? (this.lastCapture?.repeats ?? 0) + 1 : 1;
					this.lastCapture = { fingerprint: captured.fingerprint, target, repeats };
					if (repeats >= 3) return {
						content: [{ type: "text", text: "Three captures are unchanged. Workflow stopped; stop polling and reconsider the target or approach. No input token issued." }], details: {}, isError: true,
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
				const reply = await abortable(this.driver.call(operation, args, combined), combined);
				combined.throwIfAborted();
				const actionOutcome = outcome(reply, name === "computer_text" ? input.text : undefined);
				const recoveryGuidance = "retry_from_character" in actionOutcome && actionOutcome.retry_from_character !== undefined
					? "Verify the field in a fresh image before considering any remaining suffix. retry_from_character is a zero-based Unicode code-point offset, not UTF-16. retryable is driver advice, not authorization to retry."
					: undefined;
				if (driverRefused(reply)) return { content: [{ type: "text", text: JSON.stringify({ ...actionOutcome,
					guidance: recoveryGuidance ?? "Capture again before deciding; never retry input blindly." }) }], details: {}, isError: true };
				try {
					const after = await this.capture(target, combined);
					const unchanged = after.fingerprint === grounded.fingerprint;
					this.lastAction = { signature, fingerprint: after.fingerprint, unchanged };
					this.lastCapture = { fingerprint: after.fingerprint, target, repeats: 0 };
					return this.imageResult(after, { ...actionOutcome, unchanged,
						guidance: recoveryGuidance ?? (unchanged ? "No visible change; this does not prove failure. Do not repeat input blindly." : "Inspect the post-action image to verify the intended effect.") });
				} catch (error) {
					combined.throwIfAborted();
					return { content: [{ type: "text", text: JSON.stringify({ ...actionOutcome,
						observation: "unavailable", guidance: recoveryGuidance ?? "Input may have taken effect. Capture again before deciding; never repeat blindly.",
						error: error instanceof Error ? error.message.slice(0, 300) : "Post-action capture failed.",
					}) }], details: {}, isError: true };
				}
			}, combined);
			if (result.isError) await this.close();
			return result;
		} catch (error) {
			await this.close();
			throw new Error(`Computer workflow stopped. Input may have taken effect; observe before deciding, never retry blindly. ${error instanceof Error ? error.message : String(error)}`);
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
