import { Box, Container, Text } from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../../../../core/extensions/types.ts";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import { readCommunication, type SubagentCommunication } from "../intercom/communication.ts";

export function renderCommunicationBody(communication: SubagentCommunication, theme: Theme): Text {
	const direction = communication.direction === "from" ? "From" : "To";
	return new Text(`${theme.fg("muted", `${direction}: ${communication.peer}`)}\n\n${communication.message}`, 0, 0);
}

export function renderCommunicationCard(communication: SubagentCommunication, expanded: boolean, theme: Theme): Box {
	const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
	box.addChild(new Text(theme.fg("toolTitle", theme.bold(`● subagent ${communication.kind === "handoff" ? "progress" : communication.kind}`)), 0, 0));
	if (expanded) {
		box.addChild(renderCommunicationBody(communication, theme));
	}
	return box;
}

interface CommunicationArgs {
	action?: string;
	reason?: string;
	message?: string;
}

interface CommunicationResultDetails {
	communication?: SubagentCommunication;
	response?: string;
	steering?: { state?: string };
	asyncId?: string;
	state?: string;
}

export function renderCommunicationCall(
	name: string,
	args: CommunicationArgs,
	theme: Theme,
	context: Pick<ToolRenderContext<unknown, CommunicationArgs>, "result" | "expanded"> | undefined,
	communication?: SubagentCommunication,
	displayTitle?: string,
): Container {
	const container = new Container();
	const details = context?.result?.details as CommunicationResultDetails | undefined;
	const saved = readCommunication(details?.communication) ?? communication;
	const action = args.action ?? (args.reason === "need_decision" ? "request" : args.reason === "interview_request" ? "interview" : args.reason === "progress_update" ? "progress" : args.reason);
	const title = theme.fg("toolTitle", theme.bold(`${name}${action ? ` ${action}` : ""}`));
	container.addChild(new Text(displayTitle ? `${title} ${theme.fg("accent", displayTitle)}` : title, 0, 0));
	if (context?.expanded && saved) container.addChild(renderCommunicationBody(saved, theme));
	return container;
}

export function renderCommunicationResult(
	content: Array<{ type: string; text?: string }>,
	details: unknown,
	expanded: boolean,
	isError: boolean,
	theme: Theme,
): Container {
	const container = new Container();
	if (!expanded) return container;
	if (isError) {
		container.addChild(new Text(theme.fg("error", content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")), 0, 0));
	} else {
		const saved = details as CommunicationResultDetails | undefined;
		if (saved?.response) container.addChild(new Text(`\n${theme.fg("muted", "From: Supervisor")}\n\n${saved.response}`, 0, 0));
		else if (saved?.steering?.state) container.addChild(new Text(`\nDelivery: ${saved.steering.state === "recovered" ? "recovered; replacement launched" : saved.steering.state}`, 0, 0));
		else if (saved?.asyncId && saved.communication) container.addChild(new Text("\nContinuation launched.", 0, 0));
		else if (saved?.state && saved.communication) container.addChild(new Text(`\n${saved.state === "pending" ? "Question queued; awaiting an answer." : saved.state}`, 0, 0));
		else if (!saved?.communication) container.addChild(new Text(content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"), 0, 0));
	}
	return container;
}
