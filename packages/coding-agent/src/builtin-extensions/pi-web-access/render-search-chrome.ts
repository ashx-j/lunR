// @ts-nocheck
/**
 * Pure collapsed/expanded chrome for web_search and fetch_content.
 *
 * lunr: compact tool chrome. Collapsed = header + status/count only.
 * Expanded = the query/URL list. No summaries, source titles, body previews,
 * or ctrl+o footers.
 */

export function normalizeSearchQueryList(queryList: unknown[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (typeof query !== "string") continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

export function collectSearchQueries(args: { query?: unknown; queries?: unknown } | undefined): string[] {
	const input = args ?? {};
	const rawQueryList: unknown[] = Array.isArray(input.queries)
		? input.queries
		: input.query !== undefined
			? [input.query]
			: [];
	return normalizeSearchQueryList(rawQueryList);
}

export function collectFetchUrls(args: { url?: unknown; urls?: unknown } | undefined): string[] {
	const input = args ?? {};
	if (Array.isArray(input.urls)) {
		return input.urls.filter((url) => typeof url === "string" && url.length > 0);
	}
	if (typeof input.url === "string" && input.url.length > 0) {
		return [input.url];
	}
	return [];
}

export function formatSearchCallTitle(queries: string[]): { title: string; empty: boolean } {
	if (queries.length === 0) {
		return { title: "search (no query)", empty: true };
	}
	if (queries.length === 1) {
		const q = queries[0];
		const display = q.length > 60 ? `${q.slice(0, 57)}...` : q;
		return { title: `search "${display}"`, empty: false };
	}
	return { title: `search ${queries.length} queries`, empty: false };
}

export function formatFetchCallTitle(urls: string[]): { title: string; empty: boolean } {
	if (urls.length === 0) {
		return { title: "fetch (no URL)", empty: true };
	}
	if (urls.length === 1) {
		const display = urls[0].length > 60 ? `${urls[0].slice(0, 57)}...` : urls[0];
		return { title: `fetch ${display}`, empty: false };
	}
	return { title: `fetch ${urls.length} URLs`, empty: false };
}

export function formatSearchStatusLine(details) {
	const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
	let statusLine = `${queryInfo}${details?.totalResults ?? 0} sources`;
	if (details?.curated && details?.curatedFrom) {
		statusLine += ` (${details.queryCount}/${details.curatedFrom} queries curated)`;
	}
	if (details?.fetchId && details?.fetchUrls) {
		statusLine += ` (fetching ${details.fetchUrls.length} URLs)`;
	} else if (details?.fetchId) {
		statusLine += " (content ready)";
	}
	return statusLine;
}

export function formatFetchStatusLine(details) {
	const urlCount = details?.urlCount ?? 0;
	const successful = details?.successful ?? (urlCount === 1 ? 1 : 0);
	return `${successful}/${urlCount} URLs`;
}

export function formatSearchDetail(queries, details) {
	const call = formatSearchCallTitle(queries);
	const rest = call.title.replace(/^search\s+/, "");
	const status = details ? formatSearchStatusLine(details) : "";
	return status ? `${rest} · ${status}` : rest;
}

export function formatFetchDetail(urls, details) {
	const call = formatFetchCallTitle(urls);
	const rest = call.title.replace(/^fetch\s+/, "");
	const status = details ? formatFetchStatusLine(details) : "";
	return status ? `${rest} · ${status}` : rest;
}

export function formatSearchChrome(options) {
	const call = formatSearchCallTitle(options.queries);
	if (options.expanded) {
		return { call: call.title, result: options.queries.slice() };
	}
	const status = options.details ? formatSearchStatusLine(options.details) : "";
	return { call: status ? `${call.title} · ${status}` : call.title, result: [] };
}

export function formatFetchChrome(options) {
	const call = formatFetchCallTitle(options.urls);
	if (options.expanded) {
		return { call: call.title, result: options.urls.slice() };
	}
	const status = options.details ? formatFetchStatusLine(options.details) : "";
	return { call: status ? `${call.title} · ${status}` : call.title, result: [] };
}
