import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PR_WATCH_MAX_DEADLINE, type PrWatchFile, parsePullRequestUrl } from "./types.ts";

const optionalText = Type.Optional(Type.String());
const event = Type.Object({
	id: Type.String(),
	kind: Type.Union(
		["state", "head", "comment", "inline-comment", "review", "check", "status", "error", "end"].map((kind) =>
			Type.Literal(kind),
		),
	),
	text: Type.String(),
	url: optionalText,
	author: optionalText,
	body: optionalText,
	commit: optionalText,
	originalCommit: optionalText,
	location: optionalText,
	updatedAt: optionalText,
});
const snapshot = Type.Object({
	head: Type.String(),
	state: Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged")]),
	title: Type.String(),
	headRef: Type.String(),
	commitMessage: Type.String(),
	commitDate: Type.String(),
	checksComplete: Type.Boolean(),
	checks: Type.Array(Type.Object({ name: Type.String(), state: Type.String(), url: optionalText })),
	evidence: Type.Array(
		Type.Object({ key: Type.String(), fingerprint: Type.String(), event: Type.Omit(event, ["id"]) }),
	),
});
const schema = Type.Object({
	version: Type.Literal(1),
	sessionId: Type.String(),
	project: Type.String(),
	watches: Type.Array(
		Type.Object({
			id: Type.String(),
			sessionId: Type.String(),
			project: Type.String(),
			pr: Type.Object({
				owner: Type.String(),
				repo: Type.String(),
				number: Type.Integer({ minimum: 1 }),
				url: Type.String(),
			}),
			durationMs: Type.Number({ exclusiveMinimum: 0, maximum: PR_WATCH_MAX_DEADLINE }),
			deadline: Type.Number({ minimum: 0, maximum: PR_WATCH_MAX_DEADLINE }),
			nextPoll: Type.Number(),
			state: Type.Union(["active", "expired", "cancelled", "closed", "merged"].map((state) => Type.Literal(state))),
			head: optionalText,
			latest: Type.Optional(snapshot),
			seen: Type.Record(Type.String(), Type.String()),
			pending: Type.Array(event),
			deliveries: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						eventIds: Type.Array(Type.String()),
						channel: Type.Union([Type.Literal("notification"), Type.Literal("wait")]),
					}),
				),
			),
			failures: Type.Integer({ minimum: 0 }),
			errorNotified: Type.Boolean(),
		}),
	),
});

export function parsePrWatchFile(value: unknown, sessionId: string, project: string): PrWatchFile {
	if (!Value.Check(schema, value)) throw new Error("Invalid or unsupported persisted PR watch state.");
	if (value.sessionId !== sessionId || value.project !== project)
		throw new Error("PR watch state belongs to a different session/project.");
	const ids = new Set<string>();
	const urls = new Set<string>();
	for (const watch of value.watches) {
		const pr = parsePullRequestUrl(watch.pr.url);
		if (
			watch.sessionId !== sessionId ||
			watch.project !== project ||
			pr.owner !== watch.pr.owner ||
			pr.repo !== watch.pr.repo ||
			pr.number !== watch.pr.number ||
			ids.has(watch.id) ||
			urls.has(pr.url.toLowerCase())
		)
			throw new Error("Persisted PR watch identity is inconsistent.");
		ids.add(watch.id);
		urls.add(pr.url.toLowerCase());
	}
	// Value.Check validates the exact serialized shape; the literal arrays above retain runtime validation.
	return value as PrWatchFile;
}
