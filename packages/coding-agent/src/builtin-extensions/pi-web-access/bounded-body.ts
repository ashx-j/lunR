/** Fetch exposes decoded bytes. Check each chunk before retaining it or invoking a parser. */
export async function readBoundedBody(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	signal?.throwIfAborted();
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let finished = false;
	const onAbort = () => {
		void reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) {
				finished = true;
				break;
			}
			size += value.byteLength;
			if (size > maxBytes)
				throw new Error(
					`Response too large (limit ${maxBytes / 1024 / 1024}MiB)`,
				);
			chunks.push(value);
		}
		const body = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!finished) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
