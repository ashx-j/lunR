/**
 * LunrStatsFooter — the lunR stats line (absorbed from the former ashxj-tui
 * baked-in extension into core).
 *
 * A slim single-line footer rendered BELOW the prompt box:
 *   <permission mode> | <extension statuses> | <context%> | ↑in ↓out
 * Each segment is toggle-gated via settings (read at render time, so /settings
 * changes apply on the next paint). The model·provider·effort chip lives on
 * the prompt box itself (chatbox-editor.ts) and is deliberately NOT toggleable.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { Component } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { PermissionMode } from "../../../core/permissions.ts";
import type { SessionManager } from "../../../core/session-manager.ts";
import { displayWidth, safeColor, stripAnsi, truncateToWidth } from "../text-measure.ts";
import { theme } from "../theme/theme.ts";

/** Footer element toggles, mirroring the settings-manager defaults. */
export interface FooterToggles {
	mcp: boolean;
	lsp: boolean;
	context: boolean;
	tokens: boolean;
	statuses: boolean;
}

/** Minimal structural view of `getContextUsage()`'s return value. */
interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/** Everything the footer needs from the running session, as live getters. */
export interface LunrStatsFooterDeps {
	getModel(): Model<any> | undefined;
	getContextUsage(): ContextUsageLike | undefined;
	getSessionManager(): SessionManager;
	getPermissionMode(): PermissionMode | undefined;
	getFooterToggles(): FooterToggles;
}

/** Compact token-count formatter: `999`, `1.2k`, `15k`, `1.2M`, `15M`. */
function formatCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Sum input/output tokens across assistant messages in the session. */
function getUsageTotals(sessionManager: SessionManager): { input: number; output: number } {
	let input = 0;
	let output = 0;
	const entries = sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (!m || m.role !== "assistant") continue;
		const u = (m as { usage?: { input?: number; output?: number } }).usage;
		if (!u) continue;
		input += u.input ?? 0;
		output += u.output ?? 0;
	}
	return { input, output };
}

export class LunrStatsFooter implements Component {
	private disposed = false;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly deps: LunrStatsFooterDeps;

	constructor(footerData: ReadonlyFooterDataProvider, deps: LunrStatsFooterDeps) {
		this.footerData = footerData;
		this.deps = deps;
	}

	invalidate(): void {
		// render is pure
	}

	dispose(): void {
		this.disposed = true;
	}

	render(width: number): string[] {
		if (this.disposed) return [];

		const sep = safeColor(theme, "bright-black", " | ");
		const parts: string[] = [];

		// Permission mode safety indicator — always shown (not toggle-gated).
		const mode = this.deps.getPermissionMode();
		if (mode === "yolo" || mode === "auto") parts.push(safeColor(theme, "warning", mode));
		else if (mode === "manual") parts.push(safeColor(theme, "dim", "manual"));

		const toggles = this.deps.getFooterToggles();

		// 1) Statuses published via the footer data provider (by core features and
		//    by remaining extensions: MCP/LSP). Toggle-gated per group.
		const statuses = this.footerData.getExtensionStatuses();
		if (statuses.size > 0) {
			const keys: string[] = [];
			if (toggles.statuses) keys.push("plan", "goal", "swarm", "research", "tps");
			if (toggles.mcp) keys.push("mcp", "mcp-auth");
			if (toggles.lsp) keys.push("lsp");
			for (const key of keys) {
				const v = statuses.get(key);
				// Unify footer status colors to dim so the whole stats line reads as one tone.
				if (v) parts.push(safeColor(theme, "dim", stripAnsi(v)));
			}
		}

		// 2) Context usage: `pct/window`.
		if (toggles.context) {
			const usage = this.deps.getContextUsage();
			const win = this.deps.getModel()?.contextWindow ?? usage?.contextWindow ?? 0;
			const pct = usage?.percent == null ? "?" : `${Math.round(usage.percent)}%`;
			const ctxSeg = `${pct}/${formatCount(win)}`;
			const pv = usage?.percent ?? 0;
			if (pv > 90) parts.push(safeColor(theme, "error", ctxSeg));
			else if (pv > 70) parts.push(safeColor(theme, "warning", ctxSeg));
			else parts.push(safeColor(theme, "dim", ctxSeg));
		}

		// 3) Token totals: ↑in ↓out.
		if (toggles.tokens) {
			const totals = getUsageTotals(this.deps.getSessionManager());
			parts.push(safeColor(theme, "dim", `↑${formatCount(totals.input)} ↓${formatCount(totals.output)}`));
		}

		// Cost/usage counter segment deliberately absent (removed from lunR).

		let line = parts.join(sep);
		if (displayWidth(line) > width) {
			line = truncateToWidth(line, width, "");
		}
		return [line];
	}
}
