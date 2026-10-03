import { AsyncLocalStorage } from "node:async_hooks";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	private readonly requestReads = new AsyncLocalStorage<{
		providerId: string;
		observe: (apiKey: string | undefined) => void;
	}>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const override = this.overrides.get(providerId);
		if (override) return { type: "api_key", key: override };
		const credential = await this.store.read(providerId);
		const request = this.requestReads.getStore();
		if (request?.providerId === providerId) {
			request.observe(credential?.type === "api_key" ? credential.key : undefined);
		}
		return credential;
	}

	/** Observe the actual stored read for this request, excluding runtime overrides. */
	withStoredApiKeyRead<T>(
		providerId: string,
		observe: (apiKey: string | undefined) => void,
		resolve: () => Promise<T>,
	): Promise<T> {
		return this.requestReads.run({ providerId, observe }, resolve);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list()).map((entry) => [entry.providerId, entry]));
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	async delete(providerId: string): Promise<void> {
		this.overrides.delete(providerId);
		await this.store.delete(providerId);
	}
}
