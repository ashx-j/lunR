import { randomUUID } from "node:crypto";
import { GitHubReadError } from "./github.ts";
import {
	formatPrWatchBatch,
	PR_WATCH_MAX_DEADLINE,
	PR_WATCH_POLL_MS,
	type PrObservation,
	type PrWatchBatch,
	type PrWatchEvent,
	type PrWatchFile,
	type PrWatchRecord,
	type PullRequestIdentity,
	parsePullRequestUrl,
	validPrWatchDuration,
} from "./types.ts";

export interface PrWatchPersistence {
	load(): PrWatchFile;
	save(file: PrWatchFile): void;
	close(): void;
}
export interface PrWatcherOptions {
	store: PrWatchPersistence;
	read(pr: PullRequestIdentity, signal: AbortSignal): Promise<PrObservation>;
	/** Resolve true only once the notification has been persisted in the owning session. */
	deliver(batch: PrWatchBatch): Promise<boolean>;
	now?: () => number;
}
interface Waiter {
	resolve(result: PrWatchBatch | { interrupted: true }): void;
	cleanup(): void;
}

/** Finite, session-owned observation. Queue reservation gives wait and async one delivery owner. */
export class PrWatcher {
	private readonly file: PrWatchFile;
	private readonly now: () => number;
	private readonly reads = new Map<string, AbortController>();
	private readonly waiters = new Map<string, Waiter>();
	private readonly notifying = new Set<string>();
	private readonly deliveryRetries = new Map<string, number>();
	private timer?: ReturnType<typeof setTimeout>;
	private closed = false;
	private readonly options: PrWatcherOptions;
	constructor(options: PrWatcherOptions, deliveredIds: ReadonlySet<string> = new Set()) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.file = options.store.load();
		for (const watch of this.file.watches) {
			for (const delivery of watch.deliveries ?? [])
				if (deliveredIds.has(delivery.id)) this.consume(watch, delivery.eventIds);
			delete watch.deliveries;
			if (watch.state === "active") {
				if (watch.deadline <= this.now()) this.end(watch, "expired");
				else watch.nextPoll = this.now();
			}
		}
		this.save();
		this.schedule();
		queueMicrotask(() => this.flush());
	}

	list(): readonly PrWatchRecord[] {
		return this.file.watches;
	}
	private assertOpen(): void {
		if (this.closed) throw new Error("PR watch session is no longer open.");
	}
	private save(): void {
		if (!this.closed) this.options.store.save(this.file);
	}
	private find(id: string): PrWatchRecord {
		const watch = this.file.watches.find((item) => item.id === id);
		if (!watch)
			throw new Error("Unknown watch in this session. Start with a PR URL or use /pr-watch to view watches.");
		return watch;
	}

	start(url: string, durationMs: number): PrWatchRecord {
		this.assertOpen();
		if (!validPrWatchDuration(durationMs) || this.now() + durationMs > PR_WATCH_MAX_DEADLINE)
			throw new Error("PR watch duration must be positive, finite, and fit a valid deadline.");
		const pr = parsePullRequestUrl(url);
		const existing = this.file.watches.find((watch) => watch.pr.url.toLowerCase() === pr.url.toLowerCase());
		if (existing) return existing;
		const watch: PrWatchRecord = {
			id: randomUUID(),
			pr,
			sessionId: this.file.sessionId,
			project: this.file.project,
			durationMs,
			deadline: this.now() + durationMs,
			state: "active",
			seen: {},
			pending: [],
			failures: 0,
			errorNotified: false,
			nextPoll: this.now(),
		};
		this.file.watches.push(watch);
		this.save();
		this.schedule();
		return watch;
	}

	/** Called exclusively by the user command, never an agent tool action. */
	restart(id: string, durationMs: number): PrWatchRecord {
		this.assertOpen();
		const watch = this.find(id);
		if (watch.state === "active") throw new Error("Watch is already active. Cancel it before restarting.");
		if (!validPrWatchDuration(durationMs) || this.now() + durationMs > PR_WATCH_MAX_DEADLINE)
			throw new Error("PR watch duration must be positive, finite, and fit a valid deadline.");
		// Retain undelivered terminal facts, then open one new user-approved window.
		watch.durationMs = durationMs;
		watch.deadline = this.now() + durationMs;
		watch.state = "active";
		watch.nextPoll = this.now();
		watch.failures = 0;
		watch.errorNotified = false;
		watch.seen = {};
		delete watch.head;
		delete watch.latest;
		this.save();
		this.schedule();
		return watch;
	}

	cancel(id: string): void {
		this.assertOpen();
		const watch = this.find(id);
		if (watch.state === "active") this.end(watch, "cancelled");
		this.flush();
		this.schedule();
	}

	private batch(watch: PrWatchRecord, events: PrWatchEvent[]): PrWatchBatch {
		return {
			watchId: watch.id,
			prUrl: watch.pr.url,
			state: watch.state,
			deadline: watch.deadline,
			head: watch.head,
			events,
		};
	}
	private available(watch: PrWatchRecord): PrWatchEvent[] {
		const reserved = new Set(watch.deliveries?.flatMap((delivery) => delivery.eventIds));
		return watch.pending.filter((event) => !reserved.has(event.id));
	}
	private consume(watch: PrWatchRecord, ids: readonly string[]): void {
		const consumed = new Set(ids);
		watch.pending = watch.pending.filter((event) => !consumed.has(event.id));
	}
	private add(watch: PrWatchRecord, event: Omit<PrWatchEvent, "id">): void {
		watch.pending.push({ id: randomUUID(), ...event });
	}

	private reserve(
		watch: PrWatchRecord,
		events: PrWatchEvent[],
		channel: "notification" | "wait",
	): PrWatchBatch & { deliveryId: string } {
		const batch = { ...this.batch(watch, events), deliveryId: randomUUID() };
		watch.deliveries ??= [];
		watch.deliveries.push({ id: batch.deliveryId, eventIds: events.map((event) => event.id), channel });
		this.save();
		return batch;
	}

	/** Only a persisted session notification/tool-result receipt commits consumption. */
	acknowledgeDelivery(id: string): void {
		if (this.closed) return;
		for (const watch of this.file.watches) {
			const delivery = watch.deliveries?.find((item) => item.id === id);
			if (!delivery) continue;
			this.consume(watch, delivery.eventIds);
			this.releaseDelivery(watch, id);
		}
	}
	private releaseDelivery(watch: PrWatchRecord, id: string): void {
		watch.deliveries = watch.deliveries?.filter((item) => item.id !== id);
		this.save();
	}

	wait(id: string, signal?: AbortSignal): Promise<PrWatchBatch | { interrupted: true }> {
		this.assertOpen();
		const watch = this.find(id);
		if (signal?.aborted) return Promise.resolve({ interrupted: true });
		if (this.waiters.has(id)) throw new Error("This watch already has an active wait.");
		const events = this.available(watch);
		if (events.length) {
			return Promise.resolve(this.reserve(watch, events, "wait"));
		}
		if (watch.state !== "active") return Promise.resolve(this.batch(watch, []));
		return new Promise((resolve) => {
			const interrupt = () => {
				this.waiters.delete(id);
				signal?.removeEventListener("abort", interrupt);
				resolve({ interrupted: true });
				this.flush();
			};
			this.waiters.set(id, { resolve, cleanup: () => signal?.removeEventListener("abort", interrupt) });
			signal?.addEventListener("abort", interrupt, { once: true });
		});
	}

	private end(watch: PrWatchRecord, state: Exclude<PrWatchRecord["state"], "active">): void {
		if (watch.state !== "active") return;
		watch.state = state;
		this.deliveryRetries.delete(watch.id);
		this.reads.get(watch.id)?.abort();
		this.add(watch, {
			kind: "end",
			text: `Monitoring ended: ${state}. This does not mean the PR is ready. Latest known PR state: ${watch.latest?.state ?? "unknown"}; head: ${watch.head ?? "unknown"}; check/status reads: ${watch.latest?.checksComplete ? "complete" : "unconfirmed"}.`,
			body: watch.latest ? JSON.stringify(watch.latest.checks) : "No successful observation was available.",
			url: watch.pr.url,
		});
		this.save();
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.closed) return;
		const next = this.file.watches
			.filter((watch) => watch.state === "active")
			.flatMap((watch) => [watch.deadline, ...(this.reads.has(watch.id) ? [] : [watch.nextPoll])]);
		next.push(...this.deliveryRetries.values());
		if (!next.length) return;
		this.timer = setTimeout(() => this.tick(), Math.max(0, Math.min(2_147_483_647, Math.min(...next) - this.now())));
		this.timer.unref?.();
	}
	private tick(): void {
		if (this.closed) return;
		for (const [id, retryAt] of this.deliveryRetries) if (retryAt <= this.now()) this.deliveryRetries.delete(id);
		for (const watch of this.file.watches) {
			if (watch.state !== "active") continue;
			if (this.now() >= watch.deadline) this.end(watch, "expired");
			else if (this.now() >= watch.nextPoll && !this.reads.has(watch.id)) void this.poll(watch);
		}
		this.flush();
		this.schedule();
	}

	private fault(watch: PrWatchRecord, faults: PrObservation["faults"]): void {
		watch.failures++;
		watch.nextPoll = Math.max(
			this.now() + Math.min(5 * PR_WATCH_POLL_MS, PR_WATCH_POLL_MS * 2 ** Math.min(watch.failures - 1, 3)),
			...faults.map((fault) => fault.retryAt ?? 0),
		);
		if (!watch.errorNotified && (faults.some((fault) => fault.auth) || watch.failures >= 3)) {
			watch.errorNotified = true;
			this.add(watch, {
				kind: "error",
				text: "GitHub monitoring has incomplete reads and will retry within the finite watch window. No readiness or green result can be inferred.",
				body: faults.map((fault) => fault.message).join("\n"),
			});
		}
	}
	private async poll(watch: PrWatchRecord): Promise<void> {
		const controller = new AbortController();
		this.reads.set(watch.id, controller);
		this.schedule();
		try {
			const { snapshot, faults } = await this.options.read(watch.pr, controller.signal);
			if (this.closed || watch.state !== "active" || controller.signal.aborted) return;
			if (this.now() >= watch.deadline) {
				this.end(watch, "expired");
				return;
			}
			const previousHead = watch.head;
			if (previousHead && previousHead !== snapshot.head) {
				watch.deadline = this.now() + watch.durationMs;
				this.add(watch, {
					kind: "head",
					text: `Head changed from ${previousHead} to ${snapshot.head}. The original ${watch.durationMs / 60_000} minute window has restarted.`,
					commit: snapshot.head,
					body: `${snapshot.headRef}\n${snapshot.commitMessage}\n${snapshot.commitDate}`,
					url: watch.pr.url,
				});
			}
			watch.head = snapshot.head;
			if (!watch.latest)
				this.add(watch, {
					kind: "state",
					text: `Initial PR observation: ${snapshot.title}; ${snapshot.state}; head ${snapshot.head}. Check/status reads ${snapshot.checksComplete ? "complete" : "unconfirmed"}.`,
					commit: snapshot.head,
					body: JSON.stringify({
						headRef: snapshot.headRef,
						commitMessage: snapshot.commitMessage,
						commitDate: snapshot.commitDate,
						checks: snapshot.checks,
					}),
					url: watch.pr.url,
				});
			for (const evidence of snapshot.evidence) {
				if (watch.seen[evidence.key] !== evidence.fingerprint) {
					this.add(watch, evidence.event);
					watch.seen[evidence.key] = evidence.fingerprint;
				}
			}
			watch.latest = { ...snapshot, evidence: [] };
			if (faults.length) this.fault(watch, faults);
			else {
				if (watch.errorNotified)
					this.add(watch, {
						kind: "error",
						text: "GitHub reads recovered. Observation is available again; monitoring continues until its deadline.",
					});
				watch.failures = 0;
				watch.errorNotified = false;
				watch.nextPoll = this.now() + PR_WATCH_POLL_MS;
			}
			if (snapshot.state !== "open") this.end(watch, snapshot.state);
			this.save();
		} catch (error) {
			if (!this.closed && watch.state === "active" && !controller.signal.aborted) {
				this.fault(watch, [
					{
						message:
							error instanceof GitHubReadError
								? error.message
								: "GitHub network/read failure; latest state is unconfirmed.",
						auth: error instanceof GitHubReadError && error.auth,
						retryAt: error instanceof GitHubReadError ? error.retryAt : undefined,
					},
				]);
				if (watch.latest) watch.latest.checksComplete = false;
				this.save();
			}
		} finally {
			this.reads.delete(watch.id);
			this.flush();
			this.schedule();
		}
	}

	private flush(): void {
		if (this.closed) return;
		for (const watch of this.file.watches) {
			const events = this.available(watch);
			const waiter = this.waiters.get(watch.id);
			if (waiter && (events.length || watch.state !== "active")) {
				this.waiters.delete(watch.id);
				waiter.cleanup();
				const batch = events.length ? this.reserve(watch, events, "wait") : this.batch(watch, []);
				waiter.resolve(batch);
				continue;
			}
			if (
				!events.length ||
				(this.deliveryRetries.get(watch.id) ?? 0) > this.now() ||
				this.notifying.has(watch.id) ||
				watch.deliveries?.some((delivery) => delivery.channel === "notification")
			)
				continue;
			const batch = this.reserve(watch, events, "notification");
			this.notifying.add(watch.id);
			this.save();
			void this.options
				.deliver(batch)
				.then(
					(acknowledged) => {
						if (this.closed) return;
						if (acknowledged) this.acknowledgeDelivery(batch.deliveryId);
						else {
							this.releaseDelivery(watch, batch.deliveryId);
							this.deliveryRetries.set(watch.id, this.now() + PR_WATCH_POLL_MS);
						}
					},
					() => {
						if (!this.closed) {
							this.releaseDelivery(watch, batch.deliveryId);
							this.deliveryRetries.set(watch.id, this.now() + PR_WATCH_POLL_MS);
						}
					},
				)
				.finally(() => {
					this.notifying.delete(watch.id);
					// Failed admission retries independently of GitHub reads, including terminal notices.
					if (!this.closed && this.available(watch).some((event) => !events.includes(event))) this.flush();
					this.schedule();
				});
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		for (const controller of this.reads.values()) controller.abort();
		for (const waiter of this.waiters.values()) {
			waiter.cleanup();
			waiter.resolve({ interrupted: true });
		}
		this.waiters.clear();
		this.options.store.close();
	}
}

export { formatPrWatchBatch };
