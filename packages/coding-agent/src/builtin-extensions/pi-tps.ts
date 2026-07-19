import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Spinner frames for streaming animation ──
const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerIdx = 0;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;

// ── ANSI color helpers ──
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function colorForTps(tps: number): string {
	if (tps >= 100) return GREEN;
	if (tps >= 30) return YELLOW;
	return RED;
}

// ── Compact token formatting ──
function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export default function (pi: ExtensionAPI) {
	let messageStartTime = 0;
	let lastAvgTps = 0;
	let lastOutputTokens = 0;
	let isStreaming = false;

	pi.on("agent_start", async (_event, ctx) => {
		lastAvgTps = 0;
		lastOutputTokens = 0;
		if (ctx.hasUI) {
			ctx.ui.setStatus("tps", "");
		}
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			messageStartTime = Date.now();
			isStreaming = true;
			spinnerIdx = 0;
			// Start spinner animation
			if (spinnerInterval) clearInterval(spinnerInterval);
			spinnerInterval = setInterval(() => {
				spinnerIdx = (spinnerIdx + 1) % spinner.length;
			}, 80);
		}
	});

	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!ctx.hasUI) return;

		const usage = (event.message as { usage?: { output: number } }).usage;
		if (!usage) return;

		const outputTokens = usage.output;
		if (outputTokens === 0) return;

		const elapsed = (Date.now() - messageStartTime) / 1000;
		const tps = outputTokens / elapsed;
		const color = colorForTps(tps);
		const frame = spinner[spinnerIdx % spinner.length];

		ctx.ui.setStatus("tps", `${color}${frame} ${tps.toFixed(1)} t/s${RESET} ↓ ${formatTokens(outputTokens)} tokens`);
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (!ctx.hasUI) return;

		const elapsed = (Date.now() - messageStartTime) / 1000;
		const usage = (event.message as { usage?: { output: number } }).usage;
		const outputTokens = usage?.output ?? 0;

		if (elapsed > 0 && outputTokens > 0) {
			lastAvgTps = outputTokens / elapsed;
			lastOutputTokens = outputTokens;
		}

		// Stop spinner
		isStreaming = false;
		if (spinnerInterval) {
			clearInterval(spinnerInterval);
			spinnerInterval = null;
		}

		setImmediate(() => {
			const color = colorForTps(lastAvgTps);
			ctx.ui.setStatus("tps", `${color}✓ ${lastAvgTps.toFixed(1)} t/s · ${formatTokens(lastOutputTokens)} tokens in ${elapsed.toFixed(1)}s${RESET}`);
		});
	});
}
