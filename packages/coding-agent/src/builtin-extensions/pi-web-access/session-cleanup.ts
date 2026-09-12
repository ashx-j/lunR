// @ts-nocheck
/** Lightweight session teardown hooks. Heavy modules register on first load. */

type Cleanup = () => void;

const cleanups: Cleanup[] = [];

export function registerSessionCleanup(fn: Cleanup): void {
	if (!cleanups.includes(fn)) cleanups.push(fn);
}

export function runSessionCleanups(): void {
	for (const fn of cleanups) {
		try {
			fn();
		} catch {
		}
	}
}
