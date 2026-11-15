declare module "signal-exit" {
	/** Runs `callback` once when the process exits, including by a signal that ends it. Returns the remover. */
	export default function onExit(
		callback: (code: number | null, signal: NodeJS.Signals | null) => void,
		options?: { alwaysLast?: boolean },
	): () => void;
}
