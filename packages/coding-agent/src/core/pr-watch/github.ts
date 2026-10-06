import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrObservation, PrSnapshot, PrWatchEvent, PullRequestIdentity } from "./types.ts";

const exec = promisify(execFile);
const API = "https://api.github.com";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("GitHub returned an invalid object.");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("GitHub returned an invalid list.");
	return value as unknown[];
}
function author(value: unknown): string {
	return value ? string(object(value).login) : "unknown";
}

export class GitHubReadError extends Error {
	readonly auth: boolean;
	readonly retryAt?: number;
	constructor(message: string, auth = false, retryAt?: number) {
		super(message);
		this.auth = auth;
		this.retryAt = retryAt;
	}
}

/** Read existing GitHub credentials without altering GitHub CLI account configuration. */
export async function githubWatchToken(signal: AbortSignal): Promise<string | undefined> {
	const envToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
	if (envToken) return envToken;
	try {
		const result = await exec("gh", ["auth", "token", "--hostname", "github.com"], {
			timeout: 10_000,
			signal,
			maxBuffer: 64 * 1024,
		});
		return result.stdout.trim() || undefined;
	} catch {
		signal.throwIfAborted();
		// Public repositories can use anonymous GitHub access if gh is unavailable.
		return undefined;
	}
}

interface CachedPage {
	etag?: string;
	value: unknown;
	next?: string;
}
export interface GitHubReaderOptions {
	fetch?: typeof fetch;
	token?: (signal: AbortSignal) => Promise<string | undefined>;
	now?: () => number;
}

/** Complete paginated reads with per-page conditional requests and bounded request time. */
export class GitHubPrReader {
	private readonly pages = new Map<string, CachedPage>();
	private readonly fetcher: typeof fetch;
	private readonly token: (signal: AbortSignal) => Promise<string | undefined>;
	private readonly now: () => number;
	private blockedUntil = 0;
	constructor(options: GitHubReaderOptions = {}) {
		this.fetcher = options.fetch ?? fetch;
		this.token = options.token ?? githubWatchToken;
		this.now = options.now ?? Date.now;
	}

	private async page(url: string, token: string | undefined, signal: AbortSignal): Promise<CachedPage> {
		if (this.blockedUntil > this.now())
			throw new GitHubReadError(
				"GitHub rate limit reached; reads will retry after the reset.",
				false,
				this.blockedUntil,
			);
		const parsed = new URL(url);
		if (parsed.origin !== API || !parsed.pathname.startsWith("/repos/"))
			throw new GitHubReadError("GitHub pagination returned an unsupported URL.");
		const cached = this.pages.get(url);
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (token) headers.Authorization = `Bearer ${token}`;
		if (cached?.etag) headers["If-None-Match"] = cached.etag;
		const response = await this.fetcher(url, {
			headers,
			signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
			redirect: "error",
		});
		const retryHeader = response.headers.get("retry-after");
		const retrySeconds = retryHeader === null ? NaN : Number(retryHeader);
		const retryAt = retryHeader
			? Number.isFinite(retrySeconds)
				? this.now() + Math.max(0, retrySeconds * 1000)
				: Date.parse(retryHeader)
			: NaN;
		const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
		if (
			response.status === 429 ||
			(response.status === 403 && (retryHeader || response.headers.get("x-ratelimit-remaining") === "0"))
		) {
			this.blockedUntil = Math.max(
				Number.isFinite(retryAt) ? retryAt : this.now() + 60_000,
				Number.isFinite(reset) ? reset : 0,
			);
			throw new GitHubReadError(
				"GitHub rate limit reached; reads will retry after the reset.",
				false,
				this.blockedUntil,
			);
		}
		if (response.status === 304 && cached) return cached;
		if (!response.ok)
			throw new GitHubReadError(
				response.status === 401 || response.status === 403 || response.status === 404
					? `GitHub access failed (${response.status}). Check gh auth login or GH_TOKEN/GITHUB_TOKEN and repository read permissions.`
					: `GitHub read failed (${response.status}); latest state is unconfirmed.`,
				[401, 403, 404].includes(response.status),
				Number.isFinite(retryAt) ? retryAt : undefined,
			);
		const link = response.headers
			.get("link")
			?.split(",")
			.map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
			.find(Boolean);
		const page = {
			value: (await response.json()) as unknown,
			etag: response.headers.get("etag") ?? undefined,
			next: link,
		};
		this.pages.set(url, page);
		return page;
	}

	private async list(
		path: string,
		token: string | undefined,
		signal: AbortSignal,
		field?: string,
	): Promise<Record<string, unknown>[]> {
		let next: string | undefined = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
		const result: Record<string, unknown>[] = [];
		const visited = new Set<string>();
		while (next) {
			if (visited.has(next)) throw new GitHubReadError("GitHub pagination repeated a page.");
			visited.add(next);
			const page = await this.page(next, token, signal);
			result.push(...array(field ? object(page.value)[field] : page.value).map(object));
			next = page.next;
		}
		return result;
	}

	async read(pr: PullRequestIdentity, signal: AbortSignal): Promise<PrObservation> {
		const token = await this.token(signal);
		const base = `/repos/${pr.owner}/${pr.repo}`;
		const pull = object((await this.page(`${API}${base}/pulls/${pr.number}`, token, signal)).value);
		const head = object(pull.head);
		const sha = string(head.sha);
		if (!/^[a-f\d]{40,64}$/i.test(sha) || !["open", "closed"].includes(string(pull.state)))
			throw new GitHubReadError("GitHub returned an invalid pull request head/state.");
		const snapshot: PrSnapshot = {
			head: sha,
			state: pull.merged_at ? "merged" : pull.state === "closed" ? "closed" : "open",
			title: string(pull.title),
			headRef: string(head.ref),
			commitMessage: "",
			commitDate: "",
			checks: [],
			checksComplete: false,
			evidence: [],
		};
		const results = await Promise.allSettled([
			this.list(`${base}/issues/${pr.number}/comments`, token, signal),
			this.list(`${base}/pulls/${pr.number}/comments`, token, signal),
			this.list(`${base}/pulls/${pr.number}/reviews`, token, signal),
			this.list(`${base}/commits/${sha}/check-runs?filter=latest`, token, signal, "check_runs"),
			this.list(`${base}/commits/${sha}/statuses`, token, signal),
			this.page(`${API}${base}/commits/${sha}`, token, signal),
		]);
		signal.throwIfAborted();
		const faults: PrObservation["faults"] = [];
		const names = [
			"conversation comments",
			"inline comments",
			"submitted reviews",
			"check runs",
			"commit statuses",
			"head commit metadata",
		];
		const add = (key: string, event: Omit<PrWatchEvent, "id">) =>
			snapshot.evidence.push({ key, fingerprint: JSON.stringify(event), event });
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.status === "rejected") {
				const error: unknown = result.reason;
				faults.push({
					message: `${names[i]} unavailable: ${error instanceof GitHubReadError ? error.message : "network/read failure; latest state is unconfirmed"}`,
					auth: error instanceof GitHubReadError && error.auth,
					retryAt: error instanceof GitHubReadError ? error.retryAt : undefined,
				});
				continue;
			}
			if (i === 5) {
				const commit = object(object((result.value as CachedPage).value).commit);
				snapshot.commitMessage = string(commit.message);
				snapshot.commitDate = string(object(commit.committer).date);
				continue;
			}
			const rows = result.value as Record<string, unknown>[];
			const statusContexts = new Set<string>();
			for (const row of rows) {
				if (i < 3) {
					if (i === 2 && (!row.submitted_at || row.state === "PENDING")) continue;
					const kind = i === 0 ? "comment" : i === 1 ? "inline-comment" : "review";
					add(`${kind}:${String(row.id)}`, {
						kind,
						text:
							i === 2
								? `Review ${string(row.state)}`
								: kind === "comment"
									? "Conversation comment"
									: "Inline review comment",
						author: author(row.user),
						body: string(row.body),
						url: string(row.html_url),
						updatedAt: string(row.updated_at) || string(row.submitted_at) || string(row.created_at),
						...(i > 0 && row.commit_id ? { commit: string(row.commit_id) } : {}),
						...(i === 1
							? {
									originalCommit: string(row.original_commit_id),
									location: `${string(row.path)}:${row.line ?? row.original_line ?? "unknown"}${row.side ? ` ${string(row.side)}` : ""}`,
								}
							: {}),
					});
				} else if (i === 3) {
					const state = string(row.conclusion) || string(row.status);
					snapshot.checks.push({ name: string(row.name), state, url: string(row.html_url) });
					if (row.status !== "completed") continue;
					const output = row.output ? object(row.output) : {};
					add(`check:${sha}:${String(row.id)}`, {
						kind: "check",
						text: `${string(row.name)}: ${state}`,
						commit: string(row.head_sha) || sha,
						url: string(row.html_url),
						body: [string(output.title), string(output.summary), string(output.text)].filter(Boolean).join("\n"),
						updatedAt: string(row.completed_at),
					});
				} else {
					const context = string(row.context);
					// GitHub lists newest statuses first. Historical successes must not hide a rerun failure.
					if (statusContexts.has(context)) continue;
					statusContexts.add(context);
					const state = string(row.state);
					snapshot.checks.push({ name: context, state, url: string(row.target_url) });
					if (state === "pending") continue;
					add(`status:${sha}:${context}`, {
						kind: "status",
						text: `${context}: ${state}`,
						commit: sha,
						author: author(row.creator),
						body: string(row.description),
						url: string(row.target_url),
						updatedAt: string(row.updated_at),
					});
				}
			}
		}
		snapshot.checksComplete = results[3].status === "fulfilled" && results[4].status === "fulfilled";
		return { snapshot, faults };
	}
}
