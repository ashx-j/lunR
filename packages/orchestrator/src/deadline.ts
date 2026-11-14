/** Bound the whole operation, including response bodies, and cancel its transport on timeout. */
export async function withDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	description: string,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${description} timed out after ${timeoutMs}ms`);
			reject(error);
			controller.abort(error);
		}, timeoutMs);
	});
	try {
		return await Promise.race([operation(controller.signal), timeout]);
	} finally {
		clearTimeout(timer);
	}
}
