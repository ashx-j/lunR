import { Container, type Focusable, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TrackedProcess } from "../../../core/process-registry.ts";
import * as processRegistry from "../../../core/process-registry.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

function formatElapsed(startedAt: number): string {
	const ms = Date.now() - startedAt;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

export class ProcessesSelectorComponent extends Container implements Focusable {
	private processes: TrackedProcess[] = [];
	private selected = 0;
	private confirmKill: number | null = null;
	private done: () => void;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(done: () => void) {
		super();
		this.done = done;
		this.refresh();
		this.refreshTimer = setInterval(() => this.refresh(), 2000);
	}

	private refresh(): void {
		this.processes = processRegistry.list();
		if (this.selected >= this.processes.length) {
			this.selected = Math.max(0, this.processes.length - 1);
		}
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", "Background Processes")), 0, 0));
		this.addChild(new Spacer(1));

		if (this.processes.length === 0) {
			this.addChild(new Text(theme.fg("dim", "No processes tracked this session."), 0, 0));
			this.addChild(
				new Text(theme.fg("dim", "Only processes spawned directly by the bash tool are tracked."), 0, 0),
			);
			this.addChild(new Spacer(1));
		} else {
			for (let i = 0; i < this.processes.length; i++) {
				const p = this.processes[i];
				if (!p) continue;
				const elapsed = formatElapsed(p.startedAt);
				let status: string;
				if (p.status === "exited") {
					status = `exited(${p.exitCode ?? "?"})`;
				} else if (p.status === "paused") {
					status = "paused";
				} else {
					status = "running";
				}
				const prefix = i === this.selected ? "▸ " : "  ";
				const line = `${prefix}${p.pid} · ${status} · ${elapsed} · ${truncateToWidth(p.command, 60)}`;
				const colored = i === this.selected ? theme.fg("accent", line) : theme.fg("dim", line);
				this.addChild(new Text(colored, 0, 0));
			}
			this.addChild(new Spacer(1));
		}

		if (this.confirmKill !== null) {
			this.addChild(new Text(theme.fg("warning", `  Kill process ${this.confirmKill}? y/n`), 0, 0));
			this.addChild(new Spacer(1));
		}

		const isWin = processRegistry.isWindows();
		const isExited = this.processes.length > 0 && this.processes[this.selected]?.status === "exited";
		const hints: string[] = [];
		if (!isExited) hints.push(rawKeyHint("x", "kill"));
		if (!isExited) hints.push(rawKeyHint("r", "restart"));
		if (!isWin && !isExited) hints.push(rawKeyHint("p", "pause/resume"));
		hints.push(rawKeyHint("Esc", "close"));
		this.addChild(new Text(hints.join("  "), 0, 0));
		this.addChild(new DynamicBorder());
	}

	focus(): void {
		this._focused = true;
	}

	blur(): void {
		this._focused = false;
	}

	handleInput(data: string): void {
		if (this.confirmKill !== null) {
			if (data === "y" || data === "Y") {
				processRegistry.kill(this.confirmKill);
				this.confirmKill = null;
				this.refresh();
			} else {
				this.confirmKill = null;
				this.rebuild();
			}
			return;
		}

		if (data === "q") {
			this.cleanup();
			this.done();
			return;
		}
		if (getKeybindings().matches(data, "tui.select.cancel")) {
			this.cleanup();
			this.done();
			return;
		}

		if (this.processes.length === 0) return;

		if (data === "\u001b[A") {
			this.selected = (this.selected - 1 + this.processes.length) % this.processes.length;
			this.rebuild();
			return;
		}
		if (data === "\u001b[B") {
			this.selected = (this.selected + 1) % this.processes.length;
			this.rebuild();
			return;
		}

		const p = this.processes[this.selected];
		if (!p) return;

		if (p.status === "exited") return;

		if (data === "x" || data === "X") {
			this.confirmKill = p.pid;
			this.rebuild();
			return;
		}
		if (data === "r" || data === "R") {
			processRegistry.restart(p.pid);
			this.refresh();
			return;
		}
		if (data === "p" || data === "P") {
			try {
				if (p.status === "paused") processRegistry.resume(p.pid);
				else processRegistry.pause(p.pid);
			} catch {
				// ignore on win32
			}
			this.refresh();
			return;
		}
	}

	private cleanup(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}
}
