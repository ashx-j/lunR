export async function downloadAttachment(url: string, limit = 8 * 1024 * 1024): Promise<Uint8Array> {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok || !response.body) throw new Error(`Attachment request failed with HTTP ${response.status}.`);
	if (Number(response.headers.get("content-length")) > limit) {
		await response.body.cancel();
		throw new Error("Attachment exceeds the 8 MB limit.");
	}
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > limit) { await reader.cancel(); throw new Error("Attachment exceeds the 8 MB limit."); }
			parts.push(part.value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
	return bytes;
}
