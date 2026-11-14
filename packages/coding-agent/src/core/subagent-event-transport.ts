import { Buffer } from "node:buffer";

const CHUNK_TYPE = "lunr_child_event_chunk";
const CHUNK_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 24 * CHUNK_BYTES;

export function* encodeChildEventLines(json: string): Generator<string> {
	const bytes = Buffer.from(json);
	if (bytes.length > MAX_EVENT_BYTES) throw new Error(`Child event exceeds ${MAX_EVENT_BYTES} byte transport limit.`);
	if (bytes.length <= CHUNK_BYTES) {
		yield json;
		return;
	}
	const count = Math.ceil(bytes.length / CHUNK_BYTES);
	for (let index = 0; index < count; index++) {
		yield JSON.stringify({
			type: CHUNK_TYPE,
			index,
			count,
			data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
		});
	}
}

export function createChildEventDecoder(): (line: string) => string | undefined {
	let chunks: Buffer[] = [];
	let totalBytes = 0;
	let expectedCount = 0;
	return (line) => {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== CHUNK_TYPE) {
			if (chunks.length) throw new Error("Incomplete child event chunks.");
			return line;
		}
		const frame = parsed as { index?: unknown; count?: unknown; data?: unknown };
		if (!Number.isInteger(frame.index) || !Number.isInteger(frame.count) || typeof frame.data !== "string")
			throw new Error("Invalid child event chunk.");
		const index = frame.index as number;
		const count = frame.count as number;
		if (
			count < 2 ||
			count > MAX_EVENT_BYTES / CHUNK_BYTES ||
			index !== chunks.length ||
			(chunks.length && count !== expectedCount)
		)
			throw new Error("Out-of-order child event chunk.");
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
			throw new Error("Invalid child event chunk encoding.");
		const chunk = Buffer.from(frame.data, "base64");
		if (chunk.length === 0 || chunk.length > CHUNK_BYTES || totalBytes + chunk.length > MAX_EVENT_BYTES)
			throw new Error("Child event chunk exceeds transport limit.");
		chunks.push(chunk);
		totalBytes += chunk.length;
		expectedCount = count;
		if (chunks.length !== count) return undefined;
		const event = Buffer.concat(chunks, totalBytes).toString("utf8");
		chunks = [];
		totalBytes = 0;
		expectedCount = 0;
		return event;
	};
}
