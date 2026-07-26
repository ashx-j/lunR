/**
 * TpsTracker — tokens-per-second footer status (absorbed from the former
 * pi-tps baked-in extension into core).
 *
 * InteractiveMode drives this from agent events; the tracker publishes the
 * `tps` footer status via the injected callback. The footer re-colors the
 * status to dim at render time (it strips the ANSI colors applied here).
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function colorForTps(tps: number): string {
	if (tps >= 100) return GREEN;
	if (tps >= 30) return YELLOW;
	return RED;
}

function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export class TpsTracker {
	private messageStartTime = 0;
	private lastAvgTps = 0;
	private lastOutputTokens = 0;
	private spinnerIdx = 0;
	private spinnerInterval: ReturnType<typeof setInterval> | null = null;
	private readonly setStatus: (text: string | undefined) => void;

	/** Publishes the status text (undefined to clear). */
	constructor(setStatus: (text: string | undefined) => void) {
		this.setStatus = setStatus;
	}

	onAgentStart(): void {
		this.lastAvgTps = 0;
		this.lastOutputTokens = 0;
		this.setStatus("");
	}

	onMessageStart(role: string): void {
		if (role !== "assistant") return;
		this.messageStartTime = Date.now();
		this.spinnerIdx = 0;
		if (this.spinnerInterval) clearInterval(this.spinnerInterval);
		this.spinnerInterval = setInterval(() => {
			this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
		}, 80);
	}

	onMessageUpdate(role: string, outputTokens: number | undefined): void {
		if (role !== "assistant") return;
		if (!outputTokens) return;

		const elapsed = (Date.now() - this.messageStartTime) / 1000;
		const tps = outputTokens / elapsed;
		const color = colorForTps(tps);
		const frame = SPINNER[this.spinnerIdx % SPINNER.length];

		this.setStatus(`${color}${frame} ${tps.toFixed(1)} t/s${RESET} ↓ ${formatTokens(outputTokens)} tokens`);
	}

	onMessageEnd(role: string, outputTokens: number | undefined): void {
		if (role !== "assistant") return;

		const elapsed = (Date.now() - this.messageStartTime) / 1000;
		const tokens = outputTokens ?? 0;

		if (elapsed > 0 && tokens > 0) {
			this.lastAvgTps = tokens / elapsed;
			this.lastOutputTokens = tokens;
		}

		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}

		setImmediate(() => {
			const color = colorForTps(this.lastAvgTps);
			this.setStatus(
				`${color}✓ ${this.lastAvgTps.toFixed(1)} t/s · ${formatTokens(this.lastOutputTokens)} tokens in ${elapsed.toFixed(1)}s${RESET}`,
			);
		});
	}

	dispose(): void {
		if (this.spinnerInterval) {
			clearInterval(this.spinnerInterval);
			this.spinnerInterval = null;
		}
	}
}
