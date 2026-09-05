/** Poll only after the owner has painted. Timers never keep a CLI process alive. */
export function startCatalogRefreshPolling(options: {
	refresh: (signal: AbortSignal) => Promise<unknown>;
	isBusy: () => boolean;
	onUpdate: () => void;
	onError?: (error: unknown) => void;
}): () => void {
	const controller = new AbortController();
	let running = false;
	const tick = async () => {
		if (running || controller.signal.aborted || options.isBusy()) return;
		running = true;
		try {
			await options.refresh(controller.signal);
			if (!controller.signal.aborted && !options.isBusy()) options.onUpdate();
		} catch (error) {
			if (!controller.signal.aborted) options.onError?.(error);
		} finally {
			running = false;
		}
	};
	void tick();
	const timer = setInterval(() => void tick(), 60_000);
	timer.unref?.();
	return () => {
		controller.abort();
		clearInterval(timer);
	};
}
