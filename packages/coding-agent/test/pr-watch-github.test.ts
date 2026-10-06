import { describe, expect, it, vi } from "vitest";
import { GitHubPrReader, GitHubReadError } from "../src/core/pr-watch/github.ts";
import { parsePullRequestUrl } from "../src/core/pr-watch/types.ts";

const pr = parsePullRequestUrl("https://github.com/o/r/pull/1");
const head = "a".repeat(40);
const oldHead = "b".repeat(40);
const signal = new AbortController().signal;
function fixture() {
	const comments = [
		{
			id: 1,
			body: "Initial feedback",
			updated_at: "2026-10-06T11:00:00Z",
			user: { login: "review-bot" },
			html_url: `${pr.url}#issuecomment-1`,
		},
	];
	const inline = [
		{
			id: 2,
			body: "Check this line",
			commit_id: oldHead,
			original_commit_id: oldHead,
			path: "src/a.ts",
			line: 5,
			original_line: 4,
			side: "RIGHT",
			user: { login: "reviewer" },
			html_url: `${pr.url}#discussion_r2`,
		},
	];
	const reviews = [
		{
			id: 3,
			body: "Needs a fix",
			state: "CHANGES_REQUESTED",
			commit_id: oldHead,
			submitted_at: "2026-10-06T11:00:00Z",
			user: { login: "reviewer" },
			html_url: `${pr.url}#pullrequestreview-3`,
		},
	];
	const checks = [
		{
			id: 4,
			head_sha: head,
			name: "CI",
			status: "completed",
			conclusion: "failure",
			completed_at: "2026-10-06T10:55:00Z",
			html_url: "https://github.com/o/r/actions/runs/4",
			output: { title: "Failed tests", summary: "2 failures", text: "test output" },
		},
	];
	const statuses = [
		{
			id: 5,
			context: "legacy-CI",
			state: "failure",
			description: "Build failed",
			updated_at: "2026-10-06T10:56:00Z",
			target_url: "https://ci.example.test/5",
			creator: { login: "legacy" },
		},
		{ id: 6, context: "legacy-CI", state: "success" },
	];
	const fetcher = vi.fn<typeof fetch>(async (input) => {
		const url = new URL(String(input));
		const path = url.pathname;
		let body: unknown;
		if (path.endsWith("/pulls/1"))
			body = { head: { sha: head, ref: "feature" }, state: "open", merged_at: null, title: "Test" };
		else if (path.includes("/issues/1/comments")) body = comments;
		else if (path.includes("/pulls/1/comments")) body = inline;
		else if (path.includes("/reviews")) body = reviews;
		else if (path.includes("/check-runs")) body = { check_runs: checks };
		else if (path.includes("/statuses")) body = statuses;
		else body = { commit: { message: "head message", committer: { date: "2026-10-06T10:50:00Z" } } };
		return new Response(JSON.stringify(body), { headers: { etag: `"${path}"` } });
	});
	const reader = new GitHubPrReader({ fetch: fetcher, token: async () => undefined });
	return { reader, fetcher, comments, inline, reviews, checks, statuses };
}

describe("GitHub PR observation", () => {
	it("includes first feedback, body edits, author/location/links and precise commit associations", async () => {
		const f = fixture();
		const first = await f.reader.read(pr, signal);
		expect(first.faults).toEqual([]);
		expect(first.snapshot.commitMessage).toBe("head message");
		expect(first.snapshot.checksComplete).toBe(true);
		expect(first.snapshot.evidence.find((item) => item.key === "comment:1")?.event).toMatchObject({
			body: "Initial feedback",
			author: "review-bot",
			url: `${pr.url}#issuecomment-1`,
		});
		expect(first.snapshot.evidence.find((item) => item.key === "comment:1")?.event.commit).toBeUndefined();
		expect(first.snapshot.evidence.find((item) => item.key === "inline-comment:2")?.event).toMatchObject({
			commit: oldHead,
			originalCommit: oldHead,
			location: "src/a.ts:5 RIGHT",
		});
		expect(first.snapshot.evidence.find((item) => item.key === "review:3")?.event.commit).toBe(oldHead);
		f.comments[0].body = "Edited feedback";
		const edited = await f.reader.read(pr, signal);
		expect(edited.snapshot.evidence[0].fingerprint).not.toBe(first.snapshot.evidence[0].fingerprint);
		expect(edited.snapshot.evidence[0].event.body).toBe("Edited feedback");
	});

	it("suppresses pending churn and keeps latest commit-status failure above older success", async () => {
		const f = fixture();
		f.checks[0].status = "in_progress";
		f.checks[0].conclusion = "";
		f.statuses[0].state = "pending";
		let result = await f.reader.read(pr, signal);
		expect(result.snapshot.evidence.some((item) => ["check", "status"].includes(item.event.kind))).toBe(false);
		f.checks[0].status = "completed";
		f.checks[0].conclusion = "failure";
		f.statuses[0].state = "failure";
		result = await f.reader.read(pr, signal);
		expect(result.snapshot.evidence.find((item) => item.event.kind === "check")?.event.body).toContain("2 failures");
		expect(result.snapshot.checks.filter((check) => check.name === "legacy-CI")).toEqual([
			{ name: "legacy-CI", state: "failure", url: "https://ci.example.test/5" },
		]);
		expect(result.snapshot.evidence.find((item) => item.event.kind === "status")?.event.commit).toBe(head);
	});

	it("paginates every feed, even when first pages return 304, and sends conditional headers", async () => {
		const counts = new Map<string, number>();
		const fetcher = vi.fn<typeof fetch>(async (input, options) => {
			const url = new URL(String(input));
			const key = url.toString();
			const count = counts.get(key) ?? 0;
			counts.set(key, count + 1);
			const headers = new Headers(options?.headers);
			if (count) {
				expect(headers.get("if-none-match")).toBe('"cache"');
				return new Response(null, { status: 304 });
			}
			if (url.pathname.endsWith("/pulls/1"))
				return new Response(JSON.stringify({ head: { sha: head, ref: "feature" }, state: "open", title: "Test" }), {
					headers: { etag: '"cache"' },
				});
			if (url.pathname.endsWith(head))
				return new Response(JSON.stringify({ commit: { message: "message", committer: { date: "date" } } }), {
					headers: { etag: '"cache"' },
				});
			const page = url.searchParams.get("page") ?? "1";
			const row = {
				id: Number(page),
				body: `page ${page}`,
				state: "COMMENTED",
				submitted_at: "date",
				commit_id: head,
				name: `CI ${page}`,
				status: "completed",
				conclusion: "success",
				context: `context ${page}`,
			};
			const body = url.pathname.endsWith("check-runs") ? { check_runs: [row] } : [row];
			const next = new URL(url);
			next.searchParams.set("page", "2");
			return new Response(JSON.stringify(body), {
				headers: { etag: '"cache"', ...(page === "1" ? { link: `<${next}>; rel="next"` } : {}) },
			});
		});
		const reader = new GitHubPrReader({ fetch: fetcher, token: async () => "test-token" });
		const first = await reader.read(pr, signal);
		const second = await reader.read(pr, signal);
		for (const kind of ["comment", "inline-comment", "review", "check", "status"])
			expect(first.snapshot.evidence.filter((item) => item.event.kind === kind)).toHaveLength(2);
		expect(second).toEqual(first);
		expect(fetcher).toHaveBeenCalledTimes(24);
		expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer test-token");
	});

	it.each(["growth", "shrink"])(
		"refreshes pagination on 304 after page %s and preserves omitted Link headers",
		async (change) => {
			const f = fixture();
			const base = f.fetcher.getMockImplementation();
			let round = 0;
			let pageTwoReads = 0;
			const next = '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=2>; rel="next"';
			f.fetcher.mockImplementation(async (input, options) => {
				const url = new URL(String(input));
				if (!url.pathname.endsWith("/issues/1/comments")) return base!(input, options);
				if (url.searchParams.get("page") === "2") {
					pageTwoReads++;
					return new Response(
						JSON.stringify([{ id: 101, body: "New page feedback", user: { login: "reviewer" } }]),
					);
				}
				if (round) {
					expect(new Headers(options?.headers).get("if-none-match")).toBe(round === 1 ? '"v1"' : '"v2"');
					return new Response(null, {
						status: 304,
						headers: {
							etag: '"v2"',
							...(round === 1
								? {
										link:
											change === "growth"
												? next
												: '<https://api.github.com/repos/o/r/issues/1/comments?per_page=100>; rel="first"',
									}
								: {}),
						},
					});
				}
				return new Response(JSON.stringify(f.comments), {
					headers: { etag: '"v1"', ...(change === "shrink" ? { link: next } : {}) },
				});
			});
			const first = await f.reader.read(pr, signal);
			round++;
			const changed = await f.reader.read(pr, signal);
			round++;
			const unchanged = await f.reader.read(pr, signal);
			const comments = (value: typeof first) =>
				value.snapshot.evidence.filter((item) => item.event.kind === "comment");
			expect(comments(first)).toHaveLength(change === "growth" ? 1 : 2);
			expect(comments(changed)).toHaveLength(change === "growth" ? 2 : 1);
			expect(comments(unchanged)).toEqual(comments(changed));
			expect(pageTwoReads).toBe(change === "growth" ? 2 : 1);
		},
	);

	it("keeps partial evidence but marks checks unconfirmed after an endpoint fault", async () => {
		const f = fixture();
		const base = f.fetcher.getMockImplementation();
		f.fetcher.mockImplementation(async (input, options) =>
			String(input).includes("/statuses") ? new Response("{}", { status: 401 }) : base!(input, options),
		);
		const result = await f.reader.read(pr, signal);
		expect(result.snapshot.evidence.some((item) => item.event.kind === "comment")).toBe(true);
		expect(result.snapshot.checksComplete).toBe(false);
		expect(result.faults).toEqual([expect.objectContaining({ auth: true, message: expect.stringContaining("401") })]);
	});

	it("obeys rate limit reset and refuses pagination to another host", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 429, headers: { "retry-after": "120", "x-ratelimit-reset": "200" } }),
		);
		const reader = new GitHubPrReader({ fetch: fetcher, token: async () => undefined, now: () => 100_000 });
		await expect(reader.read(pr, signal)).rejects.toMatchObject({ retryAt: 220_000 });
		await expect(reader.read(pr, signal)).rejects.toBeInstanceOf(GitHubReadError);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const f = fixture();
		const base = f.fetcher.getMockImplementation();
		f.fetcher.mockImplementation(async (input, options) =>
			String(input).includes("/issues/")
				? new Response("[]", { headers: { link: '<https://evil.test/token>; rel="next"' } })
				: base!(input, options),
		);
		const result = await f.reader.read(pr, signal);
		expect(result.faults[0].message).toContain("unsupported URL");
		expect(f.fetcher.mock.calls.some(([input]) => String(input).includes("evil.test"))).toBe(false);
	});

	it("honors an HTTP-date Retry-After without treating a transient server fault as auth failure", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("{}", { status: 503, headers: { "retry-after": "Tue, 06 Oct 2026 11:02:00 GMT" } }),
		);
		const reader = new GitHubPrReader({ fetch: fetcher, token: async () => undefined });
		await expect(reader.read(pr, signal)).rejects.toMatchObject({
			auth: false,
			retryAt: Date.parse("2026-10-06T11:02:00Z"),
		});
	});
});
