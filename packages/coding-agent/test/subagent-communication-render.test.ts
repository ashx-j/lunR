import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import {
	legacySupervisorBody,
	resolveCommunicationPeer,
	type SubagentCommunication,
} from "../src/builtin-extensions/pi-subagents/src/intercom/communication.ts";
import type { SubagentState } from "../src/builtin-extensions/pi-subagents/src/shared/types.ts";
import {
	renderCommunicationCall,
	renderCommunicationCard,
	renderCommunicationResult,
} from "../src/builtin-extensions/pi-subagents/src/tui/communication.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const incoming: SubagentCommunication = {
	direction: "from",
	peer: "Inspect capture contract",
	kind: "handoff",
	message: "Use returned image pixels.\nFull evidence is in capture-contract.md.",
};
const text = (component: { render(width: number): string[] }) =>
	component
		.render(80)
		.map((line) => stripAnsi(line).trim())
		.join("\n");

beforeAll(() => initTheme("moon"));

describe("subagent communication cards", () => {
	it("collapses incoming messages and preserves click expansion through invalidation", () => {
		const component = new CustomMessageComponent(
			{
				role: "custom",
				customType: "subagent_supervisor_request",
				content: "raw routing metadata",
				display: true,
				details: { communication: incoming },
				timestamp: 1,
			},
			(_message, options, theme) => renderCommunicationCard(incoming, options.expanded, theme),
		);
		expect(text(component)).toContain("subagent handoff");
		expect(text(component)).not.toContain(incoming.peer);
		expect(text(component)).not.toContain(incoming.message);
		expect(component.handleClick(1, 80)).toBe(true);
		expect(text(component)).toContain(`From: ${incoming.peer}`);
		expect(text(component)).toContain(incoming.message);
		expect(text(component)).not.toContain("raw routing metadata");
		component.invalidate();
		expect(text(component)).toContain(incoming.message);
		component.handleClick(1, 80);
		expect(text(component)).not.toContain(incoming.message);
	});

	it("renders persisted UI-only progress without exposing internal entry data", () => {
		const communication = { ...incoming, kind: "progress" as const };
		const entry = {
			type: "custom" as const,
			customType: "subagent_supervisor_progress",
			id: "entry-id",
			parentId: null,
			timestamp: new Date(1).toISOString(),
			data: { runId: "private-run", agent: "private-child", childIndex: 0, communication },
		};
		const restored = new CustomEntryComponent(JSON.parse(JSON.stringify(entry)), (_entry, options, theme) =>
			renderCommunicationCard(communication, options.expanded, theme),
		);
		expect(text(restored)).toContain("subagent progress");
		expect(text(restored)).not.toContain(communication.peer);
		restored.handleClick(1, 80);
		expect(text(restored)).toContain(`From: ${communication.peer}`);
		expect(text(restored)).not.toMatch(/private-run|private-child|Child index|intercom target/);
		restored.invalidate();
		expect(text(restored)).toContain(communication.message);
		restored.handleClick(1, 80);
		expect(text(restored)).not.toContain(communication.message);
	});

	it("keeps outgoing tool messages collapsed while running and uses the persisted recipient in history", () => {
		const communication: SubagentCommunication = { ...incoming, direction: "to", kind: "question" };
		const args = { action: "ask", message: incoming.message };
		const tool: ToolDefinition = {
			name: "subagent_supervisor",
			label: "Supervisor",
			description: "Ask a child",
			parameters: Type.Object({ action: Type.String(), message: Type.String() }),
			async execute() {
				return { content: [{ type: "text", text: "queued" }], details: { communication } };
			},
			renderCall(input, theme, context) {
				return renderCommunicationCall("subagent_supervisor", input, theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderCommunicationResult(result.content, result.details, options.expanded, context.isError, theme);
			},
		};
		const component = new ToolExecutionComponent(
			"subagent_supervisor",
			"call-1",
			args,
			{},
			tool,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.markExecutionStarted();
		expect(text(component)).not.toContain(incoming.message);
		component.updateResult(
			{
				content: [{ type: "text", text: "Question private-request queued for private-run." }],
				details: JSON.parse(JSON.stringify({ communication })),
				isError: false,
			},
			false,
		);
		expect(text(component)).not.toContain(incoming.peer);
		component.handleClick(1, 80);
		expect(text(component)).toContain(`To: ${incoming.peer}`);
		expect(text(component)).toContain(incoming.message);
		expect(text(component)).not.toMatch(/private-request|private-run/);
	});

	it.each(["pending", "scheduled", "delivered", "recovered"])(
		"preserves %s steering delivery state in expansion only",
		(state) => {
			const details = {
				communication: { ...incoming, direction: "to" as const, kind: "steer" as const },
				steering: { state, replacementRunId: "private-replacement" },
			};
			expect(text(renderCommunicationResult([], details, false, false, theme))).toBe("");
			const expanded = text(renderCommunicationResult([], details, true, false, theme));
			expect(expanded).toContain(`Delivery: ${state}`);
			if (state === "recovered") expect(expanded).toContain("replacement launched");
			expect(expanded).not.toContain("private-replacement");
		},
	);

	it("strips only recognized legacy envelopes, retaining the message itself", () => {
		const body = "Action result contract:\nRun: this line belongs to the actual message.";
		const legacy = `Subagent progress update.\nRun: private-run\nAgent: private-child\nChild index: 0\nChild intercom target: private-target\n\n${body}`;
		expect(legacySupervisorBody(legacy)).toBe(body);
		expect(
			legacySupervisorBody(
				`${legacy}\n\nReply with: subagent_supervisor({ action: "reply", replyTo: "private-request" })`,
			),
		).toBe(body);
	});

	it("distinguishes duplicate descriptions without using routing IDs", () => {
		const state = {
			asyncJobs: new Map([
				[
					"run",
					{
						steps: [
							{ childId: "private-a", description: "Inspect contract", agent: "Inspect contract" },
							{ childId: "private-b", description: "Inspect contract", agent: "Inspect contract" },
						],
					},
				],
			]),
			foregroundControls: new Map(),
		} as unknown as SubagentState;
		expect(resolveCommunicationPeer(state, "run", 0, "private-a")).toBe("Inspect contract · 1");
		expect(resolveCommunicationPeer(state, "run", 1, "private-b")).toBe("Inspect contract · 2");
		expect(resolveCommunicationPeer(state, "missing", 0, "private-a")).toBe("Subagent 1");
	});
});
