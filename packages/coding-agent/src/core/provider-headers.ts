import type { ProviderHeaders } from "@earendil-works/pi-ai/compat";

/** Drops headers a provider config deleted (set to null), for requests that take plain header records. */
export function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}
