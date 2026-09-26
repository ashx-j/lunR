export const TODO_TOOL_NAMES = new Set(["todo"]);
export const TODOS_ENABLED_CHANGED_SYMBOL = Symbol.for("@lunr/todos-enabled-changed");

export type TodosEnabledChangedHandler = (enabled: boolean) => void;

export function notifyTodosEnabledChanged(enabled: boolean): void {
	const handler = (globalThis as Record<symbol, unknown>)[TODOS_ENABLED_CHANGED_SYMBOL] as
		| TodosEnabledChangedHandler
		| undefined;
	handler?.(enabled);
}
