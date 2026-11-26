/**
 * Session names in interactive mode: /name (alias /title) and the title lunR asks the model for
 * after the first reply of an unnamed session. InteractiveMode supplies the session through
 * SessionNameHost and SessionAutoNamerHost.
 */

import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { type Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { appendDebugLog } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { theme } from "./theme/theme.ts";

/** What /name needs from InteractiveMode. InteractiveMode builds one in `createSessionCommandHost`. */
export interface SessionNameHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly ui: TUI;
	readonly chatContainer: Container;
	showWarning(message: string): void;
}

export function handleNameCommand(host: SessionNameHost, text: string): void {
	const name = text.replace(/^\/(?:name|title)\s*/, "").trim();
	if (!name) {
		const currentName = host.sessionManager.getSessionName();
		if (currentName) {
			host.chatContainer.addChild(new Spacer(1));
			host.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
		} else {
			host.showWarning("Usage: /name <name>");
		}
		host.ui.requestRender();
		return;
	}

	host.session.setSessionName(name);
	const sessionName = host.sessionManager.getSessionName();
	if (sessionName !== name) {
		host.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`);
	}
	host.chatContainer.addChild(new Spacer(1));
	host.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${sessionName ?? name}`), 1, 0));
	host.ui.requestRender();
}

/** What auto-naming needs from InteractiveMode. InteractiveMode passes its session command host. */
export interface SessionAutoNamerHost {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	resolveModelReference(reference: string | undefined): Model<Api> | undefined;
}

/** Names a fresh session once. InteractiveMode calls `maybeAutoNameSession` on every agent_end. */
export class SessionAutoNamer {
	private readonly host: SessionAutoNamerHost;
	// Set once a title was requested or the session turned out not to be fresh.
	private triggered = false;

	constructor(host: SessionAutoNamerHost) {
		this.host = host;
	}

	/**
	 * lunr: fire-and-forget session auto-naming. After the FIRST assistant response in an
	 * unnamed session, asks the model for a short title derived from the first user message.
	 * Uses the light tier model when model tiers are enabled; otherwise the session model.
	 * Never blocks the UI; failures are swallowed to the debug log. Skipped entirely when
	 * the user has already named the session (via /name, /title, or --name).
	 */
	maybeAutoNameSession(): void {
		if (this.triggered) return;
		if (this.host.sessionManager.getSessionName()) return;
		const userMessages = this.host.session.getUserMessagesForForking();
		if (userMessages.length === 0) return; // No real turn yet; try again on the next agent_end.
		if (userMessages.length > 1) {
			// Resumed/older unnamed session — only auto-name fresh sessions.
			this.triggered = true;
			return;
		}
		this.triggered = true;
		void this.generateSessionTitle(userMessages[0].text);
	}

	private async generateSessionTitle(firstUserText: string): Promise<void> {
		try {
			let model = this.host.session.model;
			if (this.host.settingsManager.getModelTiersEnabled()) {
				const tierModel = this.host.resolveModelReference(this.host.settingsManager.getTierModel("light"));
				if (tierModel) {
					model = tierModel;
				}
			}
			if (!model) return;
			const prompt =
				"Generate a title of at most 6 words summarizing this request. " +
				"Reply with the title only — no quotes, no trailing punctuation, no prefix.\n\n" +
				`Request:\n${firstUserText.slice(0, 2000)}`;
			const requestSessionId = this.host.sessionManager.getSessionId();
			const requestSessionFile = this.host.sessionManager.getSessionFile();
			const response = await this.host.session.modelRuntime.complete(model, {
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			});
			if (this.host.sessionManager.getSessionId() !== requestSessionId) {
				if (requestSessionFile) {
					const target = SessionManager.open(requestSessionFile);
					try {
						target.appendRequestUsage("title", response);
					} finally {
						target.dispose();
					}
				}
				return;
			}
			this.host.sessionManager.appendRequestUsage("title", response);
			let title = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			title = title.replace(/^["'`]+|["'`.!?]+$/g, "").trim();
			if (!title) return;
			if (this.host.sessionManager.getSessionName()) return; // User named it while the request was in flight.
			this.host.session.setSessionName(title);
		} catch (error) {
			appendDebugLog(
				`auto-name: title generation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
