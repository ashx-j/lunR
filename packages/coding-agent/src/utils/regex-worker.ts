import { Worker } from "node:worker_threads";

/**
 * Runs user- and model-supplied regexes in one shared worker thread, so a backtracking match such as
 * `(a+)+$` never blocks the event loop. Used by the MCP proxy's regex search and the session selector.
 */

/** Outcome of one search. `indexes` holds each text's first match index, or -1. */
export type RegexSearchResult =
	| { kind: "done"; indexes: number[] }
	| { kind: "timeout" }
	| { kind: "unavailable"; reason: string };

/**
 * Bound for starting a worker, including waiting for a terminated one to exit. Bun keeps running a
 * terminated worker's regex for 1 to 5 s (it has no way to stop it sooner), and lunR starts a new
 * worker only after the old one exits, so at most 1 such thread runs at a time.
 */
const WORKER_START_TIMEOUT_MS = 10_000;
/** The worker drops a cached text set after this long without a search. */
const CACHED_TEXTS_IDLE_MS = 60_000;

// Eval code, so the Node bundle and the Bun binary need no extra worker entry file.
const WORKER_SOURCE = `const { parentPort } = require("node:worker_threads");
let cachedId, cachedTexts, idle;
parentPort.on("message", ({ id, source, flags, texts, textsId }) => {
  parentPort.postMessage({ id, type: "started" });
  if (texts && textsId !== undefined) {
    cachedId = textsId;
    cachedTexts = texts;
  }
  const list = texts ?? (textsId === cachedId ? cachedTexts : undefined);
  if (!list) return parentPort.postMessage({ id, type: "missing" });
  if (textsId !== undefined) {
    clearTimeout(idle);
    idle = setTimeout(() => { cachedId = cachedTexts = undefined; }, ${CACHED_TEXTS_IDLE_MS});
    idle.unref();
  }
  const pattern = new RegExp(source, flags);
  parentPort.postMessage({ id, type: "done", indexes: list.map((text) => text.search(pattern)) });
});
parentPort.postMessage({ type: "ready" });`;

type WorkerMessage =
	| { type: "ready" }
	| { id: number; type: "started" | "missing" }
	| { id: number; type: "done"; indexes: number[] };

interface Job {
	id: number;
	source: string;
	flags: string;
	texts: string[];
	textsId?: number;
	timeoutMs: number;
	retried: boolean;
	timer?: ReturnType<typeof setTimeout>;
	resolve: (result: RegexSearchResult) => void;
}

interface RegexWorker {
	worker: Worker;
	ready: Promise<boolean>;
	jobs: Map<number, Job>;
	cachedTextsId?: number;
	exited: boolean;
}

let live: RegexWorker | undefined;
/** Exit of the last terminated worker, until it has exited. */
let stopping: Promise<void> | undefined;
let nextJobId = 0;
let nextTextsId = 0;
const textsIds = new WeakMap<string[], number>();

/**
 * Searches each of `texts` for `source`. `timeoutMs` bounds the match alone, from when the worker
 * starts the job. With `cacheTexts`, the worker keeps `texts` and later searches of the same array
 * object send only its id, which matters for the session selector's large histories.
 */
export function searchTexts(
	source: string,
	flags: string,
	texts: string[],
	timeoutMs: number,
	options: { cacheTexts?: boolean } = {},
): Promise<RegexSearchResult> {
	let textsId: number | undefined;
	if (options.cacheTexts) {
		textsId = textsIds.get(texts) ?? nextTextsId++;
		textsIds.set(texts, textsId);
	}
	return new Promise((resolve) => {
		void run({ id: nextJobId++, source, flags, texts, textsId, timeoutMs, retried: false, resolve });
	});
}

async function run(job: Job): Promise<void> {
	const state = await startedWorker();
	if (!state) {
		job.resolve({
			kind: "unavailable",
			reason: `the regex worker did not start within ${WORKER_START_TIMEOUT_MS / 1000} s`,
		});
		return;
	}
	state.jobs.set(job.id, job);
	// A pending search keeps the process alive; an idle worker does not.
	state.worker.ref();
	post(state, job);
}

function post(state: RegexWorker, job: Job): void {
	const sendTexts = job.textsId === undefined || state.cachedTextsId !== job.textsId;
	if (job.textsId !== undefined) state.cachedTextsId = job.textsId;
	state.worker.postMessage({
		id: job.id,
		source: job.source,
		flags: job.flags,
		texts: sendTexts ? job.texts : undefined,
		textsId: job.textsId,
	});
}

/** The live worker once it reports ready, or undefined when it does not start in time. */
async function startedWorker(): Promise<RegexWorker | undefined> {
	const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
	while (!live) {
		if (stopping) {
			const remaining = deadline - Date.now();
			if (remaining <= 0 || !(await within(stopping, remaining))) return undefined;
			continue;
		}
		live = spawn();
	}
	const state = live;
	const remaining = Math.max(0, deadline - Date.now());
	if (
		await within(
			state.ready.then((ready) => ready || Promise.reject()),
			remaining,
		)
	)
		return state;
	if (live === state) stop(state);
	return undefined;
}

function spawn(): RegexWorker {
	const worker = new Worker(WORKER_SOURCE, { eval: true });
	let markReady: (ready: boolean) => void = () => {};
	const state: RegexWorker = {
		worker,
		ready: new Promise((resolve) => {
			markReady = resolve;
		}),
		jobs: new Map(),
		exited: false,
	};
	worker.on("message", (message: WorkerMessage) => {
		if (message.type === "ready") return markReady(true);
		const job = state.jobs.get(message.id);
		if (!job) return;
		if (message.type === "started") {
			job.timer = setTimeout(() => timedOut(state, job), job.timeoutMs);
		} else if (message.type === "missing") {
			state.cachedTextsId = undefined;
			clearTimeout(job.timer);
			post(state, job);
		} else if (message.type === "done") {
			finish(state, job, { kind: "done", indexes: message.indexes });
		}
	});
	worker.on("error", () => markReady(false));
	worker.on("exit", () => {
		state.exited = true;
		markReady(false);
		if (live === state) stop(state);
	});
	return state;
}

function finish(state: RegexWorker, job: Job, result: RegexSearchResult): void {
	clearTimeout(job.timer);
	state.jobs.delete(job.id);
	if (state.jobs.size === 0) state.worker.unref();
	job.resolve(result);
}

function timedOut(state: RegexWorker, job: Job): void {
	finish(state, job, { kind: "timeout" });
	stop(state);
}

/** Terminates `state`'s worker and retries its other jobs once on a new worker. */
function stop(state: RegexWorker): void {
	if (live === state) live = undefined;
	const exited = new Promise<void>((resolve) => {
		if (state.exited) resolve();
		else state.worker.once("exit", () => resolve());
	});
	stopping = exited;
	void exited.then(() => {
		if (stopping === exited) stopping = undefined;
	});
	void state.worker.terminate();
	for (const job of [...state.jobs.values()]) {
		clearTimeout(job.timer);
		state.jobs.delete(job.id);
		if (job.retried) {
			job.resolve({ kind: "timeout" });
		} else {
			job.retried = true;
			void run(job);
		}
	}
}

/** True when `promise` resolves within `ms`, false when it rejects or the time runs out. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(false);
			},
		);
	});
}
