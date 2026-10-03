/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Clones snapshots with the supplied policy, or structuredClone by default.
 * Popped snapshots are returned directly, without cloning again.
 */
export class UndoStack<S> {
	private stack: S[] = [];

	private readonly clone: (state: S) => S;

	constructor(clone: (state: S) => S = structuredClone) {
		this.clone = clone;
	}

	/** Push a detached snapshot of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.clone(state));
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
