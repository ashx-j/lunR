import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "../../core/tools/truncate.ts";

function utf8Prefix(bytes: Buffer, limit: number): string {
	let end = Math.min(limit, bytes.length);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Page every retrieval response, including lists and errors. Offset counts UTF-8 bytes. */
export function contentPage(
	text: string,
	offset = 0,
	details: Record<string, unknown> = {},
) {
	const bytes = Buffer.from(text, "utf8");
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		offset > bytes.length ||
		(offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)
	) {
		return {
			content: [
				{
					type: "text" as const,
					text: "Invalid offset. Use 0 or the nextOffset returned by the previous page.",
				},
			],
			details: { error: "Invalid offset" },
		};
	}

	// Reserve space for the continuation notice within the same byte and line limits.
	const remaining = bytes.subarray(offset).toString("utf8");
	const page = truncateHead(remaining, {
		maxBytes: DEFAULT_MAX_BYTES - 256,
		maxLines: DEFAULT_MAX_LINES - 3,
	});
	const body = page.firstLineExceedsLimit
		? utf8Prefix(bytes.subarray(offset), DEFAULT_MAX_BYTES - 256)
		: page.content;
	const end = offset + Buffer.byteLength(body, "utf8");
	const truncated = end < bytes.length;
	const notice = truncated
		? `\n\n[Truncated. Continue with the same responseId and selectors, offset: ${end}.]`
		: "";
	const metadata = Object.fromEntries(
		Object.entries(details).map(([key, value]) => [
			key,
			typeof value === "string"
				? utf8Prefix(Buffer.from(value, "utf8"), 512)
				: value,
		]),
	);
	return {
		content: [{ type: "text" as const, text: body + notice }],
		details: {
			...metadata,
			offset,
			nextOffset: truncated ? end : null,
			truncated,
			totalBytes: bytes.length,
			pageBytes: end - offset,
		},
	};
}
