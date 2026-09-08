/**
 * Central timing instrumentation for startup profiling.
 * Enable with PI_TIMING=1 environment variable.
 */

const ENABLED = process.env.PI_TIMING === "1";
interface TimingNamespace {
	timings: Array<{ label: string; ms: number }>;
	lastTime: number;
}

type TimingLabel = "main" | "extensions" | "imports" | "lifecycle";

const timingNamespaces = new Map<TimingLabel, TimingNamespace>();
let importMainMs: number | undefined;

export function noteImportMain(ms: number): void {
	importMainMs = ms;
}

export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const timings =
		namespace === "main" && importMainMs !== undefined ? [{ label: "import:main", ms: importMainMs }] : [];
	timingNamespaces.set(namespace, { timings, lastTime: Date.now() });
}

export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

export async function measureStartup<T>(
	label: string,
	operation: () => T | Promise<T>,
	namespace: TimingLabel = "extensions",
): Promise<T> {
	if (!ENABLED) return operation();
	const started = performance.now();
	try {
		return await operation();
	} finally {
		if (!timingNamespaces.has(namespace)) resetTimings(namespace);
		timingNamespaces.get(namespace)!.timings.push({ label, ms: performance.now() - started });
	}
}

function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms.toFixed(1)}ms`);
	}
	if (title.endsWith("main")) {
		console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0).toFixed(1)}ms`);
	}
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
