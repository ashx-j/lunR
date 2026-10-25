/**
 * Readable provider errors for the TUI and print mode.
 *
 * Provider adapters put the raw HTTP body in `errorMessage`, often as
 * `401: {"error":{"message":"..."}}`. The TUI assistant message and print mode
 * both call `describeProviderError`; the TUI keeps the raw text for its
 * expanded view.
 */

export interface ProviderErrorDescription {
	/** One line with the JSON body replaced by its message. Equals the raw text when nothing could be parsed. */
	summary: string;
	/** HTTP status when the message or body carries one. */
	status?: number;
	/** Next step for a rejected key or login (401/403), worded for the mode. */
	hint?: string;
}

/** A leading `401` or a parenthesized `(401)`, the two shapes provider adapters prefix bodies with. */
const STATUS_PREFIX = /^([45]\d\d)\b|\(([45]\d\d)\)/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `message`, `error` or `error.message`; falls back to a non-generic `type` such as `FreeTierError`. */
function bodyMessage(body: Record<string, unknown>): string | undefined {
	const error = body.error;
	return (
		nonEmpty(body.message) ??
		nonEmpty(error) ??
		(isRecord(error) ? (nonEmpty(error.message) ?? nonEmpty(error.type)) : undefined) ??
		(body.type !== "error" ? nonEmpty(body.type) : undefined)
	);
}

function bodyStatus(body: Record<string, unknown>): number | undefined {
	const code = isRecord(body.error) ? body.error.code : body.status;
	return typeof code === "number" && code >= 400 && code < 600 ? code : undefined;
}

/**
 * Turns a raw provider error into a short summary plus, for 401/403, one line
 * naming the provider and how to fix the key. `interactive` points at
 * `/login <provider>`; `print` explains that /login lives in the TUI.
 */
export function describeProviderError(
	raw: string,
	provider: string | undefined,
	mode: "interactive" | "print",
): ProviderErrorDescription {
	const text = raw.trim();
	const jsonStart = text.indexOf("{");
	const head = (jsonStart === -1 ? text : text.slice(0, jsonStart)).trim();
	const match = STATUS_PREFIX.exec(head);
	let status = match ? Number(match[1] ?? match[2]) : undefined;
	let summary = text;

	if (jsonStart !== -1) {
		let body: unknown;
		try {
			body = JSON.parse(text.slice(jsonStart));
		} catch {
			body = undefined;
		}
		if (isRecord(body)) {
			status ??= bodyStatus(body);
			const message = bodyMessage(body);
			if (message) {
				const prefix = head.replace(/:$/, "").trim();
				summary = prefix ? `${prefix}: ${message}` : message;
			}
		}
	}

	const name = provider && provider !== "unknown" ? provider : undefined;
	let hint: string | undefined;
	if (status === 401 || status === 403) {
		const who = name ?? "The provider";
		hint =
			mode === "interactive"
				? `${who} rejected the key or login. Run /login${name ? ` ${name}` : ""} to fix it.`
				: `${who} rejected the key or login. Run lunr, then /login, or set the env key.`;
	}
	return { summary, status, hint };
}
