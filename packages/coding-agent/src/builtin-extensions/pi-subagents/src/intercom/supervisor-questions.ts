import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../shared/types.ts";

export const QUESTIONS_DIR = "questions";
export const SUPERVISOR_CHANNEL_ROOT = path.join(TEMP_ROOT_DIR, "supervisor-channels");
export const SUBAGENT_SUPERVISOR_ANSWER_TYPE = "subagent_supervisor_answer";
export const SUBAGENT_QUESTION_EVENT = "subagent:supervisor-question";

export type SupervisorQuestionPublicState = "pending" | "answered" | "expired" | "cancelled";

export interface SupervisorChildIncarnation {
	pid: number;
	readyAt: number;
}

export interface SupervisorQuestion {
	type: "subagent.supervisor.question";
	id: string;
	createdAt: number;
	expiresAt: number;
	reason: string;
	message: string;
	runId: string;
	childIndex: number;
	childId: string;
	parentSessionId: string;
	parentGeneration: number;
	childIncarnation?: SupervisorChildIncarnation;
	deliveredAt?: number;
	answeredAt?: number;
	expiredAt?: number;
	cancelledAt?: number;
	cancelReason?: string;
	notifiedAt?: number;
	lateAnswerAt?: number;
	answer?: string;
}

export interface SupervisorQuestionOwner {
	runId: string;
	childIndex: number;
	childId: string;
	pid: number;
	readyAt: number;
}

interface QuestionRecord {
	type: "subagent.supervisor.question";
	id: string;
	createdAt: number;
	expiresAt: number;
	reason: string;
	message: string;
	runId: string;
	childIndex: number;
	childId: string;
	parentSessionId: string;
	parentGeneration: number;
	childIncarnation?: SupervisorChildIncarnation;
}

interface DeliveredRecord {
	type: "subagent.supervisor.delivered";
	id: string;
	at: number;
	pid: number;
	readyAt: number;
}

type TerminalRecord =
	| { type: "subagent.supervisor.terminal"; id: string; state: "answered"; at: number; message: string }
	| { type: "subagent.supervisor.terminal"; id: string; state: "expired"; at: number }
	| { type: "subagent.supervisor.terminal"; id: string; state: "cancelled"; at: number; reason: string };

interface NotifiedRecord {
	type: "subagent.supervisor.notified";
	id: string;
	at: number;
}

interface LateAnswerRecord {
	type: "subagent.supervisor.late-answer";
	id: string;
	at: number;
	message: string;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
const activeQuestionWaits = new Set<string>();

function askTimeoutMs(): number {
	const parsed = Number(process.env.PI_INTERCOM_ASK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ASK_TIMEOUT_MS;
}

function safeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function resolveSupervisorChannelDir(runId: string, agent: string, childIndex: number): string {
	return path.join(SUPERVISOR_CHANNEL_ROOT, `${safeSegment(runId)}-${safeSegment(agent)}-${childIndex}`);
}

export function questionsDir(channelDir: string): string {
	return path.join(channelDir, QUESTIONS_DIR);
}

function questionFile(channelDir: string, questionId: string): string {
	return path.join(questionsDir(channelDir), `${safeSegment(questionId)}.json`);
}

function deliveredFile(channelDir: string, questionId: string): string {
	return path.join(questionsDir(channelDir), `${safeSegment(questionId)}.delivered.json`);
}

function terminalFile(channelDir: string, questionId: string): string {
	return path.join(questionsDir(channelDir), `${safeSegment(questionId)}.terminal.json`);
}

function notifiedFile(channelDir: string, questionId: string): string {
	return path.join(questionsDir(channelDir), `${safeSegment(questionId)}.notified.json`);
}

function lateFile(channelDir: string, questionId: string): string {
	return path.join(questionsDir(channelDir), `${safeSegment(questionId)}.late.json`);
}

function writeExclusiveJson(filePath: string, payload: object): boolean {
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: "utf-8", flag: "wx", mode: 0o600 });
		// Publish a complete record without overwriting a competing terminal outcome.
		fs.linkSync(temporary, filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function readJsonFile(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function tryReadJson(filePath: string): unknown | undefined {
	try {
		return readJsonFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return undefined;
	}
}

function parseIncarnation(raw: unknown): SupervisorChildIncarnation | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<SupervisorChildIncarnation>;
	const pid = input.pid;
	const readyAt = input.readyAt;
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) return undefined;
	if (typeof readyAt !== "number" || !Number.isFinite(readyAt) || readyAt <= 0) return undefined;
	return { pid, readyAt };
}

function parseQuestionRecord(raw: unknown): QuestionRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<QuestionRecord>;
	if (input.type !== "subagent.supervisor.question") return undefined;
	if (typeof input.id !== "string" || !input.id.trim()) return undefined;
	if (typeof input.createdAt !== "number" || !Number.isFinite(input.createdAt)) return undefined;
	if (typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt)) return undefined;
	if (typeof input.reason !== "string" || !input.reason.trim()) return undefined;
	if (typeof input.message !== "string" || !input.message.trim()) return undefined;
	if (typeof input.runId !== "string" || !input.runId.trim()) return undefined;
	const childIndex = input.childIndex;
	if (!Number.isInteger(childIndex) || childIndex === undefined || childIndex < 0) return undefined;
	if (typeof input.childId !== "string" || !input.childId.trim()) return undefined;
	if (typeof input.parentSessionId !== "string" || !input.parentSessionId.trim()) return undefined;
	const parentGeneration = input.parentGeneration;
	if (!Number.isInteger(parentGeneration) || parentGeneration === undefined || parentGeneration < 0) return undefined;
	const incarnation = parseIncarnation(input.childIncarnation);
	return {
		type: "subagent.supervisor.question",
		id: input.id.trim(),
		createdAt: input.createdAt,
		expiresAt: input.expiresAt,
		reason: input.reason.trim(),
		message: input.message.trim(),
		runId: input.runId.trim(),
		childIndex,
		childId: input.childId.trim(),
		parentSessionId: input.parentSessionId.trim(),
		parentGeneration,
		...(incarnation ? { childIncarnation: incarnation } : {}),
	};
}

function parseDeliveredRecord(raw: unknown): DeliveredRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<DeliveredRecord>;
	if (input.type !== "subagent.supervisor.delivered" || typeof input.id !== "string" || !input.id.trim()) return undefined;
	if (typeof input.at !== "number" || !Number.isFinite(input.at)) return undefined;
	const incarnation = parseIncarnation(input);
	if (!incarnation) return undefined;
	return { type: "subagent.supervisor.delivered", id: input.id.trim(), at: input.at, pid: incarnation.pid, readyAt: incarnation.readyAt };
}

function parseTerminalRecord(raw: unknown): TerminalRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<TerminalRecord> & { message?: unknown; reason?: unknown };
	if (input.type !== "subagent.supervisor.terminal" || typeof input.id !== "string" || !input.id.trim()) return undefined;
	if (typeof input.at !== "number" || !Number.isFinite(input.at)) return undefined;
	if (input.state === "answered") {
		if (typeof input.message !== "string" || !input.message.trim()) return undefined;
		return { type: "subagent.supervisor.terminal", id: input.id.trim(), state: "answered", at: input.at, message: input.message };
	}
	if (input.state === "expired") {
		return { type: "subagent.supervisor.terminal", id: input.id.trim(), state: "expired", at: input.at };
	}
	if (input.state === "cancelled") {
		if (typeof input.reason !== "string" || !input.reason.trim()) return undefined;
		return { type: "subagent.supervisor.terminal", id: input.id.trim(), state: "cancelled", at: input.at, reason: input.reason.trim() };
	}
	return undefined;
}

function parseNotifiedRecord(raw: unknown): NotifiedRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<NotifiedRecord>;
	if (input.type !== "subagent.supervisor.notified" || typeof input.id !== "string" || !input.id.trim()) return undefined;
	if (typeof input.at !== "number" || !Number.isFinite(input.at)) return undefined;
	return { type: "subagent.supervisor.notified", id: input.id.trim(), at: input.at };
}

function parseLateRecord(raw: unknown): LateAnswerRecord | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const input = raw as Partial<LateAnswerRecord>;
	if (input.type !== "subagent.supervisor.late-answer" || typeof input.id !== "string" || !input.id.trim()) return undefined;
	if (typeof input.at !== "number" || !Number.isFinite(input.at) || typeof input.message !== "string") return undefined;
	return { type: "subagent.supervisor.late-answer", id: input.id.trim(), at: input.at, message: input.message };
}

function composeQuestion(record: QuestionRecord, channelDir: string): SupervisorQuestion {
	const delivered = parseDeliveredRecord(tryReadJson(deliveredFile(channelDir, record.id)));
	const terminal = parseTerminalRecord(tryReadJson(terminalFile(channelDir, record.id)));
	const notified = parseNotifiedRecord(tryReadJson(notifiedFile(channelDir, record.id)));
	const late = parseLateRecord(tryReadJson(lateFile(channelDir, record.id)));
	return {
		...record,
		...(delivered ? { deliveredAt: delivered.at, childIncarnation: record.childIncarnation ?? { pid: delivered.pid, readyAt: delivered.readyAt } } : {}),
		...(terminal?.state === "answered" ? { answeredAt: terminal.at, answer: terminal.message } : {}),
		...(terminal?.state === "expired" ? { expiredAt: terminal.at } : {}),
		...(terminal?.state === "cancelled" ? { cancelledAt: terminal.at, cancelReason: terminal.reason } : {}),
		...(notified ? { notifiedAt: notified.at } : {}),
		...(late ? { lateAnswerAt: late.at, ...(terminal?.state === "answered" ? {} : { answer: late.message }) } : {}),
	};
}

function assertMessageSize(value: string, label: string): void {
	if (Buffer.byteLength(value, "utf-8") > MAX_MESSAGE_BYTES) throw new Error(`${label} is too large.`);
}

export function ensureQuestionsDir(channelDir: string): void {
	fs.mkdirSync(questionsDir(channelDir), { recursive: true, mode: 0o700 });
}

export function supervisorQuestionPublicState(question: SupervisorQuestion): SupervisorQuestionPublicState {
	if (question.answeredAt) return "answered";
	if (question.expiredAt) return "expired";
	if (question.cancelledAt) return "cancelled";
	return "pending";
}

export function supervisorQuestionIsTerminal(question: SupervisorQuestion): boolean {
	return supervisorQuestionPublicState(question) !== "pending";
}

export function readSupervisorQuestion(channelDir: string, questionId: string): SupervisorQuestion | undefined {
	const record = parseQuestionRecord(tryReadJson(questionFile(channelDir, questionId)));
	if (!record || record.id !== questionId) return undefined;
	return composeQuestion(record, channelDir);
}

export function listSupervisorQuestions(channelDir: string): SupervisorQuestion[] {
	const dir = questionsDir(channelDir);
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && !name.endsWith(".delivered.json") && !name.endsWith(".terminal.json") && !name.endsWith(".notified.json") && !name.endsWith(".late.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const questions: SupervisorQuestion[] = [];
	for (const entry of entries.sort()) {
		const record = parseQuestionRecord(tryReadJson(path.join(dir, entry)));
		if (record) questions.push(composeQuestion(record, channelDir));
	}
	return questions;
}

function writeTerminal(channelDir: string, record: TerminalRecord): boolean {
	return writeExclusiveJson(terminalFile(channelDir, record.id), record);
}

function readTerminal(channelDir: string, questionId: string): TerminalRecord | undefined {
	return parseTerminalRecord(tryReadJson(terminalFile(channelDir, questionId)));
}

export function createSupervisorQuestion(input: {
	channelDir: string;
	reason: string;
	message: string;
	runId: string;
	childIndex: number;
	childId: string;
	parentSessionId: string;
	parentGeneration: number;
	childIncarnation?: SupervisorChildIncarnation;
	now?: number;
	timeoutMs?: number;
	id?: string;
}): SupervisorQuestion {
	const reason = input.reason.trim();
	const message = input.message.trim();
	if (!reason) throw new Error("reason is required and must name the concrete decision the child's answer will change.");
	if (!message) throw new Error("message is required for supervisor questions.");
	assertMessageSize(reason, "reason");
	assertMessageSize(message, "message");
	const createdAt = input.now ?? Date.now();
	const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : askTimeoutMs();
	const record: QuestionRecord = {
		type: "subagent.supervisor.question",
		id: input.id ?? randomUUID(),
		createdAt,
		expiresAt: createdAt + timeoutMs,
		reason,
		message,
		runId: input.runId,
		childIndex: input.childIndex,
		childId: input.childId,
		parentSessionId: input.parentSessionId,
		parentGeneration: input.parentGeneration,
		...(input.childIncarnation ? { childIncarnation: input.childIncarnation } : {}),
	};
	assertMessageSize(JSON.stringify(record), "Supervisor question");
	ensureQuestionsDir(input.channelDir);
	if (!writeExclusiveJson(questionFile(input.channelDir, record.id), record)) {
		throw new Error(`Supervisor question '${record.id}' already exists.`);
	}
	return composeQuestion(record, input.channelDir);
}

export function outstandingQuestionsForChild(channelDir: string, childIndex: number, childId?: string): SupervisorQuestion[] {
	refreshSupervisorQuestionLifecycle(channelDir);
	return listSupervisorQuestions(channelDir).filter((question) => {
		if (supervisorQuestionIsTerminal(question)) return false;
		if (question.childIndex !== childIndex) return false;
		if (childId && question.childId !== childId) return false;
		return true;
	});
}

export function hasBlockingSupervisorRequest(channelDir: string, runId: string, childIndex: number): boolean {
	const directory = path.join(channelDir, "requests");
	if (!fs.existsSync(directory)) return false;
	for (const name of fs.readdirSync(directory)) {
		if (!name.endsWith(".json")) continue;
		const raw = tryReadJson(path.join(directory, name));
		if (!raw || typeof raw !== "object") continue;
		const request = raw as { type?: unknown; id?: unknown; expectsReply?: unknown; runId?: unknown; childIndex?: unknown; expiresAt?: unknown };
		if (request.type !== "subagent.supervisor.request" || request.expectsReply !== true) continue;
		if (request.runId !== runId || request.childIndex !== childIndex || typeof request.id !== "string") continue;
		if (typeof request.expiresAt === "number" && request.expiresAt <= Date.now()) continue;
		if (!fs.existsSync(path.join(channelDir, "replies", `${safeSegment(request.id)}.json`))) return true;
	}
	return false;
}

export function hasOutstandingQuestionForChild(channelDir: string, childIndex: number, childId?: string): boolean {
	return outstandingQuestionsForChild(channelDir, childIndex, childId).length > 0;
}

export function incarnationMatches(expected: SupervisorChildIncarnation | undefined, actual: SupervisorChildIncarnation): boolean {
	if (!expected) return true;
	return expected.pid === actual.pid && expected.readyAt === actual.readyAt;
}

function assertOwner(question: SupervisorQuestion, owner: SupervisorQuestionOwner): void {
	if (owner.runId !== question.runId || owner.childIndex !== question.childIndex || owner.childId !== question.childId) {
		throw new Error(`Supervisor question '${question.id}' is not owned by this child.`);
	}
	if (!incarnationMatches(question.childIncarnation, { pid: owner.pid, readyAt: owner.readyAt })) {
		throw new Error(`Supervisor question '${question.id}' was bound to a different child incarnation.`);
	}
}

function ownerMatchesDelivered(channelDir: string, questionId: string, owner: SupervisorQuestionOwner): boolean {
	const delivered = parseDeliveredRecord(tryReadJson(deliveredFile(channelDir, questionId)));
	if (!delivered) return true;
	return delivered.pid === owner.pid && delivered.readyAt === owner.readyAt;
}

export function markSupervisorQuestionDelivered(
	channelDir: string,
	questionId: string,
	owner: SupervisorQuestionOwner,
	now = Date.now(),
): SupervisorQuestion | undefined {
	const current = readSupervisorQuestion(channelDir, questionId);
	if (!current || supervisorQuestionIsTerminal(current)) return current;
	assertOwner(current, owner);
	writeExclusiveJson(deliveredFile(channelDir, questionId), {
		type: "subagent.supervisor.delivered",
		id: questionId,
		at: now,
		pid: owner.pid,
		readyAt: owner.readyAt,
	} satisfies DeliveredRecord);
	return readSupervisorQuestion(channelDir, questionId);
}

function rejectLateOrDuplicate(channelDir: string, questionId: string, answer: string, now: number, terminal: TerminalRecord): never {
	writeExclusiveJson(lateFile(channelDir, questionId), {
		type: "subagent.supervisor.late-answer",
		id: questionId,
		at: now,
		message: answer,
	} satisfies LateAnswerRecord);
	if (terminal.state === "answered") throw new Error(`Supervisor question '${questionId}' was already answered.`);
	throw new Error(`Supervisor question '${questionId}' is ${terminal.state} and no longer accepts an answer.`);
}

export function answerSupervisorQuestion(
	channelDir: string,
	questionId: string,
	answer: string,
	owner: SupervisorQuestionOwner,
	now = Date.now(),
): SupervisorQuestion {
	const trimmed = answer.trim();
	if (!trimmed) throw new Error("message is required for supervisor question replies.");
	assertMessageSize(trimmed, "answer");
	const current = readSupervisorQuestion(channelDir, questionId);
	if (!current) throw new Error(`No supervisor question found for replyTo '${questionId}'.`);
	assertOwner(current, owner);
	if (!ownerMatchesDelivered(channelDir, questionId, owner)) {
		throw new Error(`Supervisor question '${questionId}' was bound to a different child incarnation.`);
	}
	if (now > current.expiresAt) {
		writeTerminal(channelDir, { type: "subagent.supervisor.terminal", id: questionId, state: "expired", at: now });
		const terminal = readTerminal(channelDir, questionId);
		if (terminal && terminal.state !== "answered") {
			rejectLateOrDuplicate(channelDir, questionId, trimmed, now, terminal);
		}
		if (terminal?.state === "answered") throw new Error(`Supervisor question '${questionId}' was already answered.`);
	}
	const existing = readTerminal(channelDir, questionId);
	if (existing) rejectLateOrDuplicate(channelDir, questionId, trimmed, now, existing);
	if (!writeTerminal(channelDir, { type: "subagent.supervisor.terminal", id: questionId, state: "answered", at: now, message: trimmed })) {
		const terminal = readTerminal(channelDir, questionId);
		if (terminal) rejectLateOrDuplicate(channelDir, questionId, trimmed, now, terminal);
		throw new Error(`Supervisor question '${questionId}' is no longer pending.`);
	}
	const answered = readSupervisorQuestion(channelDir, questionId);
	if (!answered) throw new Error(`Supervisor question '${questionId}' is no longer pending.`);
	return answered;
}

export function expireSupervisorQuestion(channelDir: string, questionId: string, now = Date.now()): SupervisorQuestion | undefined {
	const current = readSupervisorQuestion(channelDir, questionId);
	if (!current || supervisorQuestionIsTerminal(current) || now <= current.expiresAt) return current && supervisorQuestionIsTerminal(current) ? current : undefined;
	if (!writeTerminal(channelDir, { type: "subagent.supervisor.terminal", id: questionId, state: "expired", at: now })) return readSupervisorQuestion(channelDir, questionId);
	return readSupervisorQuestion(channelDir, questionId);
}

export function cancelSupervisorQuestion(
	channelDir: string,
	questionId: string,
	reason: string,
	now = Date.now(),
): SupervisorQuestion | undefined {
	const current = readSupervisorQuestion(channelDir, questionId);
	if (!current || supervisorQuestionIsTerminal(current)) return current;
	if (!writeTerminal(channelDir, { type: "subagent.supervisor.terminal", id: questionId, state: "cancelled", at: now, reason: reason.trim() || "cancelled" })) {
		return readSupervisorQuestion(channelDir, questionId);
	}
	return readSupervisorQuestion(channelDir, questionId);
}

export function refreshSupervisorQuestionLifecycle(channelDir: string, now = Date.now()): SupervisorQuestion[] {
	const changed: SupervisorQuestion[] = [];
	for (const question of listSupervisorQuestions(channelDir)) {
		if (supervisorQuestionIsTerminal(question)) continue;
		if (now > question.expiresAt) {
			const expired = expireSupervisorQuestion(channelDir, question.id, now);
			if (expired && expired.expiredAt) changed.push(expired);
		}
	}
	return changed;
}

export function formatParentQuestionForChild(question: SupervisorQuestion): string {
	return [
		`Parent question (${question.id})`,
		`Decision needed: ${question.reason}`,
		"",
		question.message,
		"",
		`Reply with: contact_supervisor({ action: "reply", replyTo: "${question.id}", message: "..." })`,
		"Answer from current findings and uncertainty. Do not silently start extra investigation. Continue the assigned task after replying.",
	].join("\n");
}

export function formatSupervisorQuestionAnswer(question: SupervisorQuestion): string {
	const state = supervisorQuestionPublicState(question);
	const header = state === "answered"
		? `Subagent answer (${question.id})`
		: `Subagent question ${state} (${question.id})`;
	const lines = [
		header,
		`Run: ${question.runId}`,
		`Child: ${question.childId} [#${question.childIndex}]`,
		`Decision: ${question.reason}`,
	];
	if (state === "answered" && question.answer?.trim()) {
		lines.push("", question.answer.trim());
	} else if (question.cancelReason) {
		lines.push("", question.cancelReason);
	}
	return lines.join("\n");
}

export function registerQuestionWait(questionIds: Iterable<string>): () => void {
	const ids = [...questionIds];
	for (const id of ids) activeQuestionWaits.add(id);
	return () => {
		for (const id of ids) activeQuestionWaits.delete(id);
	};
}

export function isQuestionWaitActive(questionId: string): boolean {
	return activeQuestionWaits.has(questionId);
}

export function claimQuestionNotification(channelDir: string, questionId: string, now = Date.now()): boolean {
	return writeExclusiveJson(notifiedFile(channelDir, questionId), {
		type: "subagent.supervisor.notified",
		id: questionId,
		at: now,
	} satisfies NotifiedRecord);
}

export function markSupervisorQuestionNotified(channelDir: string, questionId: string, now = Date.now()): SupervisorQuestion | undefined {
	claimQuestionNotification(channelDir, questionId, now);
	return readSupervisorQuestion(channelDir, questionId);
}

export function resetSupervisorQuestionTestState(): void {
	activeQuestionWaits.clear();
}

export function listSupervisorChannelDirs(): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(SUPERVISOR_CHANNEL_ROOT, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(SUPERVISOR_CHANNEL_ROOT, entry.name));
}

export function findSupervisorQuestion(questionId: string): { channelDir: string; question: SupervisorQuestion } | undefined {
	const id = questionId.trim();
	if (!id) return undefined;
	for (const channelDir of listSupervisorChannelDirs()) {
		const question = readSupervisorQuestion(channelDir, id);
		if (question) return { channelDir, question };
	}
	return undefined;
}

export function cancelPendingSupervisorQuestionsForOwner(input: {
	parentSessionId: string;
	parentGeneration?: number;
	runId?: string;
	reason: string;
	now?: number;
}): SupervisorQuestion[] {
	if (!input.parentSessionId?.trim()) return [];
	const now = input.now ?? Date.now();
	const cancelled: SupervisorQuestion[] = [];
	for (const channelDir of listSupervisorChannelDirs()) {
		for (const question of listSupervisorQuestions(channelDir)) {
			if (supervisorQuestionIsTerminal(question)) continue;
			if (question.parentSessionId !== input.parentSessionId) continue;
			if (input.parentGeneration !== undefined && question.parentGeneration !== input.parentGeneration) continue;
			if (input.runId && question.runId !== input.runId) continue;
			const next = cancelSupervisorQuestion(channelDir, question.id, input.reason, now);
			if (next?.cancelledAt) cancelled.push(next);
		}
	}
	return cancelled;
}

export function pendingSupervisorQuestionsForDelivery(channelDir: string, owner: SupervisorQuestionOwner, now = Date.now()): SupervisorQuestion[] {
	refreshSupervisorQuestionLifecycle(channelDir, now);
	return listSupervisorQuestions(channelDir).filter((question) => {
		if (supervisorQuestionIsTerminal(question)) return false;
		if (question.deliveredAt) return false;
		if (question.runId !== owner.runId || question.childIndex !== owner.childIndex || question.childId !== owner.childId) return false;
		if (!incarnationMatches(question.childIncarnation, { pid: owner.pid, readyAt: owner.readyAt })) return false;
		return now <= question.expiresAt;
	});
}
