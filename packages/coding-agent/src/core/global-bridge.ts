/**
 * Typed slots on `globalThis` for process-wide bridges keyed by `Symbol.for("@lunr/...")`.
 *
 * Core and the builtin extensions can be loaded through different module loaders (the Node
 * bundle, tsx, jiti), so module-level state is not shared between them; `globalThis` is. Create one
 * slot per bridge next to its type and use it for both registration and lookup:
 *
 *   const slot = globalBridge<MyBridge>(Symbol.for("@lunr/my-bridge"));
 *   slot.set(bridge);
 *   slot.get()?.doSomething();
 */
export interface GlobalBridge<T> {
	/** The registered value, or undefined when nothing registered it. */
	get(): T | undefined;
	/** Registers a value; `undefined` removes the slot. */
	set(value: T | undefined): void;
}

export function globalBridge<T>(key: symbol): GlobalBridge<T> {
	const slots = globalThis as typeof globalThis & Record<symbol, unknown>;
	return {
		// The key is private to one bridge, so whatever sits there was stored through `set`.
		get: () => slots[key] as T | undefined,
		set: (value) => {
			if (value === undefined) delete slots[key];
			else slots[key] = value;
		},
	};
}
