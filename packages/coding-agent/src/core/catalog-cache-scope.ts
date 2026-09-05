import { createHash } from "node:crypto";
import type { Credential } from "@earendil-works/pi-ai";

export function catalogCacheScope(provider: string, baseUrl: string, credential?: Credential): string {
	const identity =
		credential?.type === "oauth"
			? typeof credential.accountId === "string"
				? credential.accountId
				: credential.refresh || credential.access
			: credential?.key;
	return createHash("sha256")
		.update(JSON.stringify([provider, baseUrl.replace(/\/+$/, ""), identity ?? null]))
		.digest("hex");
}
