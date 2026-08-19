/**
 * Terminal mouse event parsing (SGR + X10).
 *
 * SGR: ESC[<button;x;yM (press) / m (release)
 * X10: ESC[M + 3 bytes (button+32, x+32, y+32)
 *
 * Wheel: bit 6 set. low bits 0=up, 1=down, 2=left, 3=right.
 */

export const MOUSE_TRACKING_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_TRACKING_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export type MouseKind = "wheel" | "button" | "move";

export interface ParsedMouseEvent {
	kind: MouseKind;
	/** Raw low button id, or 64+low for wheel. */
	button: number;
	/** +1 wheel up (older chat), -1 wheel down (newer). 0 if not vertical wheel. */
	delta: number;
	x: number;
	y: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	release: boolean;
}

const BUTTON_SHIFT = 4;
const BUTTON_ALT = 8;
const BUTTON_CTRL = 16;
const BUTTON_MOTION = 32;
const BUTTON_WHEEL = 64;
const BUTTON_EXTRA = 128;

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseMouseEvent(data: string): ParsedMouseEvent | undefined {
	if (!data.startsWith("\x1b[")) return undefined;

	const sgr = data.match(SGR_MOUSE);
	if (sgr) {
		const cb = Number.parseInt(sgr[1]!, 10);
		const x = Number.parseInt(sgr[2]!, 10);
		const y = Number.parseInt(sgr[3]!, 10);
		if (!Number.isFinite(cb) || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
		return decodeMouse(cb, x, y, sgr[4] === "m");
	}

	if (data.startsWith("\x1b[M") && data.length >= 6) {
		const cb = data.charCodeAt(3) - 32;
		const x = data.charCodeAt(4) - 32;
		const y = data.charCodeAt(5) - 32;
		if (cb < 0 || x < 1 || y < 1) return undefined;
		return decodeMouse(cb, x, y, (cb & 3) === 3);
	}

	return undefined;
}

function decodeMouse(cb: number, x: number, y: number, release: boolean): ParsedMouseEvent {
	const shift = (cb & BUTTON_SHIFT) !== 0;
	const alt = (cb & BUTTON_ALT) !== 0;
	const ctrl = (cb & BUTTON_CTRL) !== 0;
	const motion = (cb & BUTTON_MOTION) !== 0;
	const wheel = (cb & BUTTON_WHEEL) !== 0;
	const extra = (cb & BUTTON_EXTRA) !== 0;
	const low = cb & 3;

	if (wheel) {
		let delta = 0;
		if (low === 0) delta = 1;
		else if (low === 1) delta = -1;
		return {
			kind: "wheel",
			button: BUTTON_WHEEL + low,
			delta,
			x,
			y,
			shift,
			alt,
			ctrl,
			release: false,
		};
	}

	if (motion) {
		return {
			kind: "move",
			button: extra ? 8 + low : low,
			delta: 0,
			x,
			y,
			shift,
			alt,
			ctrl,
			release: false,
		};
	}

	return {
		kind: "button",
		button: extra ? 8 + low : low,
		delta: 0,
		x,
		y,
		shift,
		alt,
		ctrl,
		release,
	};
}
