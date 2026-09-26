import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { loadInstallFeatures } from "../install-features.ts";

const listeners = new Set<(enabled: boolean) => void>();

export function browserEnabledDefault(): boolean {
	return loadInstallFeatures().features.browser?.enabled !== false;
}

export function readBrowserSettings(): { enabled: boolean; allowPrivate: boolean } {
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) ?? {};
	} catch {}
	return {
		enabled: typeof settings.browserEnabled === "boolean" ? settings.browserEnabled : browserEnabledDefault(),
		allowPrivate:
			typeof settings.browserAllowPrivateNetwork === "boolean"
				? settings.browserAllowPrivateNetwork
				: loadInstallFeatures().features.browser?.options["allow-private-network"] === true,
	};
}

export function onBrowserEnabledChange(listener: (enabled: boolean) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function notifyBrowserEnabledChange(enabled: boolean): void {
	for (const listener of listeners) listener(enabled);
}
