/**
 * Permission modes in interactive mode: /mode, /plan, Shift+Tab cycling, the auto review model
 * picker, the auto review decision dialog, plan restore and `/goal`'s temporary mode. The
 * controller owns the mode history (`previousPermissionMode`, `preGoalPermissionMode`);
 * InteractiveMode supplies the session and UI through PermissionControllerHost.
 */

import type { Api } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AutoReviewer } from "../../core/auto-review.ts";
import { nextModeForGoal } from "../../core/permission-mode-control.ts";
import {
	type ApprovalResponse,
	nextPermissionMode,
	type PermissionMode,
	restorePermissionModeAfterPlan,
} from "../../core/permissions.ts";
import { disableRollbackForSession, enableRollbackForSession } from "../../core/rollback.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";

/** What the controller needs from InteractiveMode. InteractiveMode builds one in `createPermissionControllerHost`. */
export interface PermissionControllerHost {
	readonly session: AgentSession;
	readonly ui: TUI;
	/** True while the session is detached or being transferred; mode changes are ignored then. */
	isSessionDetached(): boolean;
	/** Marks this terminal as active for session handoff. */
	recordActivity(): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	/** Replaces the editor with a selector; `done` restores the editor. */
	showSelector(create: (done: () => void) => { component: Component; focus: Component }): void;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	/** Resolves a saved `provider/id` reference to a model. */
	resolveModelReference(reference: string | undefined): Model<Api> | undefined;
	sendUserMessageAfterDeferredBuiltins(text: string): Promise<void>;
}

export class PermissionModeController {
	private readonly host: PermissionControllerHost;

	// Restore the previous mode after approving a plan or leaving read-only via /plan.
	private previousPermissionMode: PermissionMode | undefined;

	// lunr: mode in effect before `/goal` forced session auto. Dedicated so it cannot
	// collide with plan restore.
	private preGoalPermissionMode: PermissionMode | undefined;

	constructor(host: PermissionControllerHost) {
		this.host = host;
	}

	/** Forgets the mode history; called before a replacement session binds. */
	resetHistory(): void {
		this.previousPermissionMode = undefined;
		this.preGoalPermissionMode = undefined;
	}

	cyclePermissionMode(): void {
		this.applyPermissionMode(nextPermissionMode(this.host.session.permissionMode), { silent: true, fromCycle: true });
	}

	// /plan is a shortcut into read-only mode for planning.
	async handlePlanCommand(args: string): Promise<void> {
		const sub = args.toLowerCase();
		const inReadOnly = this.host.session.permissionMode === "read-only";

		if (sub === "status") {
			this.host.showStatus(
				inReadOnly
					? "Read mode is active. /plan off to leave it."
					: `Permission mode: ${this.host.session.permissionMode}.`,
			);
			return;
		}

		if (sub !== "" && sub !== "on" && sub !== "off") {
			if (!inReadOnly) this.applyPermissionMode("read-only");
			await this.host.sendUserMessageAfterDeferredBuiltins(`Create a plan for: ${args}`);
			return;
		}

		const next = sub !== "off";
		if (next === inReadOnly) {
			this.host.showStatus(next ? "Read mode is already active." : "Read mode is already off.");
			return;
		}

		if (next) {
			this.applyPermissionMode("read-only");
			return;
		}
		// With read as the saved default and no earlier mode, there is nothing to go back to.
		const target = this.restoreTargetAfterPlan();
		if (target === "read-only") {
			this.host.showStatus(
				"Read is your default mode, so /plan off has nothing to restore. Use /mode yolo or /mode auto.",
			);
			return;
		}
		this.applyPermissionMode(target);
	}

	handleModeCommand(args: string): void {
		const sub = args.toLowerCase();

		if (sub === "status") {
			this.host.showStatus(
				`Permission mode: ${this.host.session.permissionMode === "read-only" ? "read" : this.host.session.permissionMode}`,
			);
			return;
		}

		if (sub === "yolo" || sub === "auto" || sub === "read-only" || sub === "read") {
			this.applyPermissionMode(sub === "read" ? "read-only" : sub);
			return;
		}

		if (sub !== "") {
			this.host.showStatus("Usage: /mode [yolo|auto|read] — bare /mode opens the selector.");
			return;
		}

		const options = [
			"YOLO — auto-approve tools, agent may still ask",
			"Auto — a review model checks risky actions",
			"Read — inspect without making changes",
		];
		void this.host.showExtensionSelector("Permission mode", options).then((choice) => {
			if (!choice) return;
			if (choice.startsWith("YOLO")) this.applyPermissionMode("yolo");
			else if (choice.startsWith("Auto")) this.applyPermissionMode("auto");
			else if (choice.startsWith("Read")) this.applyPermissionMode("read-only");
		});
	}

	/** Destination after plan approval or /plan off. */
	restoreTargetAfterPlan(): PermissionMode {
		return restorePermissionModeAfterPlan(
			this.previousPermissionMode,
			this.host.session.settingsManager.getDefaultPermissionMode(),
		);
	}

	/** Apply addendum + auto-rollback for a mode without a status toast. */
	syncPermissionModeEffects(mode: PermissionMode): void {
		if (this.host.isSessionDetached()) return;
		this.host.session.setPermissionMode(mode);
		if (mode === "auto") enableRollbackForSession(this.host.session.sessionManager.getSessionId());
	}

	// lunr: `/goal` works without questions in the current mode (read-only steps up to yolo), without writing settings.
	enterGoalAuto(): void {
		const next = nextModeForGoal(this.host.session.permissionMode, "enter", this.preGoalPermissionMode);
		this.preGoalPermissionMode = next.saved;
		if (next.mode !== this.host.session.permissionMode) {
			this.applyPermissionMode(next.mode, { silent: true });
		}
		this.host.session.setAutonomous(true);
		enableRollbackForSession(this.host.session.sessionManager.getSessionId());
	}

	leaveGoalAuto(): void {
		const next = nextModeForGoal(this.host.session.permissionMode, "leave", this.preGoalPermissionMode);
		this.preGoalPermissionMode = next.saved;
		this.host.session.setAutonomous(false);
		if (next.mode !== this.host.session.permissionMode) {
			this.applyPermissionMode(next.mode, { silent: true });
		}
		if (this.host.session.permissionMode !== "auto")
			disableRollbackForSession(this.host.session.sessionManager.getSessionId());
	}

	/**
	 * `cancelMode` is where to go if auto needs a review model and the user cancels the picker; without it
	 * the mode stays as it was. `fromCycle` (Shift+Tab) lets the cycle key skip past auto from that picker.
	 */
	applyPermissionMode(
		mode: PermissionMode,
		opts?: { silent?: boolean; cancelMode?: PermissionMode; fromCycle?: boolean },
	): void {
		if (this.host.isSessionDetached()) return;
		if (mode === "auto") {
			const reviewer = this.host.session.resolveAutoReviewer();
			if (reviewer.kind !== "ready") {
				this.showAutoReviewModelPicker(reviewer, opts?.cancelMode, opts?.fromCycle);
				return;
			}
		}
		this.host.recordActivity();
		const prev = this.host.session.permissionMode;
		if (mode === "read-only" && prev !== "read-only") {
			this.previousPermissionMode = prev;
		}
		this.host.session.setPermissionMode(mode);
		this.host.ui.requestRender();

		if (mode === "auto" && prev !== "auto") {
			enableRollbackForSession(this.host.session.sessionManager.getSessionId());
		} else if (mode !== "auto" && prev === "auto") {
			disableRollbackForSession(this.host.session.sessionManager.getSessionId());
		}

		if (opts?.silent) return;

		if (mode === "auto" && prev !== "auto") {
			const reviewer = this.host.session.resolveAutoReviewer();
			const by = reviewer.kind === "ready" ? reviewer.ref : "the review model";
			this.host.showStatus(`Auto mode active. ${by} checks risky actions. Rollback enabled for this session.`);
		} else if (mode === "read-only") {
			this.host.showStatus("Read mode active. Changes are blocked.");
		} else {
			this.host.showStatus(`Permission mode: ${mode}`);
		}
	}

	/**
	 * Opens the model list so the user can pick the auto review model, then enters auto. With a
	 * `reviewer` the picker notes why auto needs one, and cancelling switches to `cancelMode` if given,
	 * otherwise keeps the current mode, with one status line either way. With `fromCycle`, the cycle key
	 * closes the picker and moves on to the mode after auto, so Shift+Tab alone still reaches read.
	 */
	showAutoReviewModelPicker(
		reviewer?: Exclude<AutoReviewer, { kind: "ready" }>,
		cancelMode?: PermissionMode,
		fromCycle?: boolean,
	): void {
		const note =
			reviewer?.kind === "missing"
				? `${reviewer.provider}'s own coding agent has no review model, so auto mode needs one.`
				: reviewer
					? `Auto review model ${reviewer.ref} isn't available.`
					: undefined;
		this.host.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.host.ui,
				this.host.resolveModelReference(this.host.session.settingsManager.getAutoReviewModel()) ??
					this.host.session.model,
				this.host.session.settingsManager,
				this.host.session.modelRuntime,
				this.host.session.scopedModels,
				(model) => {
					done();
					this.host.session.settingsManager.setAutoReviewModel(`${model.provider}/${model.id}`);
					if (reviewer) this.applyPermissionMode("auto");
					else this.host.showStatus(`Auto review model: ${model.provider}/${model.id}`);
				},
				() => {
					done();
					if (reviewer) {
						const switched = cancelMode !== undefined && cancelMode !== this.host.session.permissionMode;
						if (switched) this.applyPermissionMode(cancelMode, { silent: true });
						const mode =
							this.host.session.permissionMode === "read-only" ? "read" : this.host.session.permissionMode;
						this.host.showStatus(
							`No review model picked. ${switched ? "Switched to" : "Still in"} ${mode} mode.`,
						);
					}
					this.host.ui.requestRender();
				},
				undefined,
				{
					persistDefault: false,
					title: "Pick the model that reviews risky actions in auto mode",
					note,
					onCyclePermissionMode: fromCycle
						? () => {
								done();
								this.applyPermissionMode(nextPermissionMode("auto"), { silent: true });
								this.host.ui.requestRender();
							}
						: undefined,
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/** Startup check for a session that opens in auto without a usable review model. */
	warnIfAutoHasNoReviewer(): void {
		if (this.host.session.permissionMode !== "auto") return;
		const reviewer = this.host.session.resolveAutoReviewer();
		if (reviewer.kind === "ready") return;
		this.host.showWarning(
			`Auto mode has no ${reviewer.kind === "missing" ? `review model for ${reviewer.provider}` : `reachable review model (${reviewer.ref})`}, so lunR will ask you before risky actions. Run /mode auto to pick one.`,
		);
	}

	// Dialog when auto mode's review model kept blocking, or couldn't review, one action.
	async showAutoReviewDecisionDialog(req: { toolName: string; detail: string }): Promise<ApprovalResponse> {
		return new Promise((resolve) => {
			this.host.showSelector((done) => {
				const selector = new ExtensionSelectorComponent(
					`Auto review stopped a ${req.toolName} call. Run it anyway?`,
					["Run it once", "Keep it blocked"],
					(option) => {
						done();
						resolve(option === "Run it once" ? "once" : "reject");
					},
					() => {
						done();
						resolve("reject");
					},
					{ message: req.detail.slice(0, 800) },
				);
				return { component: selector, focus: selector };
			});
		});
	}
}
