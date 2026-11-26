/**
 * Tree navigation for AgentSession: moving the leaf to another entry of the same session file
 * (/tree, /undo, /redo, RPC `navigate_tree`), with an optional summary of the branch left
 * behind, and the user messages the fork selector lists. AgentSession keeps the public
 * `navigateTree` with its guards and supplies the session through TreeNavigationHost.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai/compat";
import { collectEntriesForBranchSummary, generateBranchSummary } from "./compaction/index.ts";
import type { ExtensionRunner, SessionBeforeTreeResult, TreePreparation } from "./extensions/index.ts";
import type { BranchSummaryEntry, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** What tree navigation needs from AgentSession. AgentSession builds one in `createTreeNavigationHost`. */
export interface TreeNavigationHost {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly extensionRunner: ExtensionRunner;
	readonly model: Model<Api> | undefined;
	/** Set while a navigation runs; AgentSession's `isCompacting` and `abortBranchSummary` read it. */
	branchSummaryAbortController: AbortController | undefined;
	getSummarizationRequestAuth(
		model: Model<Api>,
	): Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
}

/** Moves the session leaf to `targetId`, optionally summarizing the branch it leaves. AgentSession's `navigateTree` calls it after its guards. */
export async function runTreeNavigation(
	host: TreeNavigationHost,
	targetId: string,
	options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
): Promise<{
	editorText?: string;
	editorImages?: ImageContent[];
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
}> {
	const oldLeafId = host.sessionManager.getLeafId();

	// No-op if already at target
	if (targetId === oldLeafId) {
		return { cancelled: false };
	}

	// Model required for summarization
	if (options.summarize && !host.model) {
		throw new Error("No model available for summarization");
	}

	const targetEntry = host.sessionManager.getEntry(targetId);
	if (!targetEntry) {
		throw new Error(`Entry ${targetId} not found`);
	}

	// Collect entries to summarize (from old leaf to common ancestor)
	const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
		host.sessionManager,
		oldLeafId,
		targetId,
	);

	// Prepare event data - mutable so extensions can override
	let customInstructions = options.customInstructions;
	let replaceInstructions = options.replaceInstructions;
	let label = options.label;

	const preparation: TreePreparation = {
		targetId,
		oldLeafId,
		commonAncestorId,
		entriesToSummarize,
		userWantsSummary: options.summarize ?? false,
		customInstructions,
		replaceInstructions,
		label,
	};

	// Set up abort controller for summarization
	host.branchSummaryAbortController = new AbortController();

	try {
		let extensionSummary: { summary: string; details?: unknown } | undefined;
		let fromExtension = false;

		// Emit session_before_tree event
		if (host.extensionRunner.hasHandlers("session_before_tree")) {
			const result = (await host.extensionRunner.emit({
				type: "session_before_tree",
				preparation,
				signal: host.branchSummaryAbortController.signal,
			})) as SessionBeforeTreeResult | undefined;

			if (result?.cancel) {
				return { cancelled: true };
			}

			if (result?.summary && options.summarize) {
				extensionSummary = result.summary;
				fromExtension = true;
			}

			// Allow extensions to override instructions and label
			if (result?.customInstructions !== undefined) {
				customInstructions = result.customInstructions;
			}
			if (result?.replaceInstructions !== undefined) {
				replaceInstructions = result.replaceInstructions;
			}
			if (result?.label !== undefined) {
				label = result.label;
			}
		}

		// Run default summarizer if needed
		let summaryText: string | undefined;
		let summaryDetails: unknown;
		if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
			const model = host.model!;
			const { apiKey, headers, env } = await host.getSummarizationRequestAuth(model);
			const branchSummarySettings = host.settingsManager.getBranchSummarySettings();
			const result = await generateBranchSummary(entriesToSummarize, {
				model,
				apiKey,
				headers,
				env,
				signal: host.branchSummaryAbortController.signal,
				customInstructions,
				replaceInstructions,
				reserveTokens: branchSummarySettings.reserveTokens,
				streamFn: host.agent.streamFn,
				onUsage: (response) => host.sessionManager.appendRequestUsage("branch-summary", response),
			});
			if (result.aborted) {
				return { cancelled: true, aborted: true };
			}
			if (result.error) {
				throw new Error(result.error);
			}
			summaryText = result.summary;
			summaryDetails = {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			};
		} else if (extensionSummary) {
			summaryText = extensionSummary.summary;
			summaryDetails = extensionSummary.details;
		}

		if (host.branchSummaryAbortController.signal.aborted) return { cancelled: true, aborted: true };
		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;
		let editorImages: ImageContent[] | undefined;

		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = extractUserMessageText(targetEntry.message.content);
			editorImages = extractUserMessageImages(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		// Switch leaf (with or without summary)
		// Summary is attached at the navigation target position (newLeafId), not the old branch
		let summaryEntry: BranchSummaryEntry | undefined;
		if (summaryText) {
			// Create summary at target position (can be null for root)
			const summaryId = host.sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
			summaryEntry = host.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

			// Attach label to the summary entry
			if (label) {
				host.sessionManager.appendLabelChange(summaryId, label);
			}
		} else if (newLeafId === null) {
			// No summary, navigating to root - reset leaf
			host.sessionManager.resetLeaf();
		} else {
			// No summary, navigating to non-root
			host.sessionManager.branch(newLeafId);
		}

		// Attach label to target entry when not summarizing (no summary entry to label)
		if (label && !summaryText) {
			host.sessionManager.appendLabelChange(targetId, label);
		}

		// Update agent state
		const sessionContext = host.sessionManager.buildSessionContext();
		host.agent.state.messages = sessionContext.messages;

		// Emit session_tree event
		await host.extensionRunner.emit({
			type: "session_tree",
			newLeafId: host.sessionManager.getLeafId(),
			oldLeafId,
			summaryEntry,
			fromExtension: summaryText ? fromExtension : undefined,
		});

		// Emit to custom tools

		return { editorText, editorImages, cancelled: false, summaryEntry };
	} finally {
		host.branchSummaryAbortController = undefined;
	}
}

/**
 * User messages on the active branch, for the fork selector. Turns rewound by /undo or left on
 * another branch are not listed; /tree reaches those.
 */
export function getUserMessagesForForking(host: TreeNavigationHost): Array<{ entryId: string; text: string }> {
	const entries = host.sessionManager.getBranch();
	const result: Array<{ entryId: string; text: string }> = [];

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		const text = extractUserMessageText(entry.message.content);
		if (text) {
			result.push({ entryId: entry.id, text });
		}
	}

	return result;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

function extractUserMessageImages(
	content: string | Array<{ type: string; mimeType?: string; data?: string }>,
): ImageContent[] | undefined {
	if (typeof content === "string" || !Array.isArray(content)) return undefined;
	const images = content.filter(
		(part): part is ImageContent =>
			part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
	return images.length > 0 ? images : undefined;
}
