import { globalBridge } from "./global-bridge.ts";
export const TODO_TOOL_NAMES = new Set(["todo"]);
export const TODOS_ENABLED_CHANGED_SYMBOL = Symbol.for("@lunr/todos-enabled-changed");

export type TodosEnabledChangedHandler = (enabled: boolean) => void;

const todosEnabledChangedSlot = globalBridge<TodosEnabledChangedHandler>(TODOS_ENABLED_CHANGED_SYMBOL);

export function notifyTodosEnabledChanged(enabled: boolean): void {
	todosEnabledChangedSlot.get()?.(enabled);
}
