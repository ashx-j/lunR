import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type ModelsStreamTransforms,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { CatalogOverlaySource, knownModelKeys, withCatalogOverlay } from "./catalog-merge.ts";
import {
	buildLiveOverlay,
	fetchLiveProviderModels,
	type IncompleteLiveModel,
	isLiveListProvider,
	LIVE_LIST_PROVIDER_IDS,
	type LiveCatalogResult,
} from "./live-catalog.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	loadOfficialCatalog,
	type OfficialCatalogLoadResult,
	officialCatalogCachePath,
	officialEntryToModel,
	officialModelKeys,
} from "./official-catalog.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";
import { SubscriptionManager } from "./subscriptions.ts";
import { type UserModelEntry, UserModelsStore, userEntryToModel, userModelsPath } from "./user-models.ts";

interface ModelRuntimeSnapshot {
	all: readonly Model<Api>[];
	available: readonly Model<Api>[];
	configuredProviders: ReadonlySet<string>;
	storedProviders: ReadonlySet<string>;
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

export interface CreateModelRuntimeOptions {
	/** Credential storage. Defaults to the file at authPath. */
	credentials?: CredentialStore;
	authPath?: string;
	modelsPath?: string | null;
	modelsStore?: ModelsStore;
	modelsStorePath?: string;
	allowModelNetwork?: boolean;
	/** Applied by callers of `refresh()`, not by `create()` (startup is cache-only). */
	modelRefreshTimeoutMs?: number;
	/** Unused. Kept so older callers compiling against this options bag still typecheck. */
	catalogBaseUrl?: string;
	/** lunr: subscription-key pool. Defaults to subscriptions.json next to authPath (in-memory for custom stores). */
	subscriptions?: SubscriptionManager;
}

export interface CatalogRefreshResult extends ModelsRefreshResult {
	official?: OfficialCatalogLoadResult & { evictedUserRows: number };
	live: LiveCatalogResult[];
	incomplete: IncompleteLiveModel[];
}

export interface ModelRuntimeAuthOverrides {
	apiKey?: string;
	env?: Record<string, string>;
}

function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/** Configured pi-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	/** lunr: per-provider subscription-key pools; rotation mirrors the active key into the credential store. */
	readonly subscriptionManager: SubscriptionManager;
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	private readonly builtins = new Map<string, Provider>();
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	private readonly compositionErrors = new Map<string, string>();
	private readonly modelsPath: string | undefined;
	private readonly allowModelNetwork: boolean;
	private config: ModelConfig;
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefresh: Promise<void> | undefined;
	private availabilityError: string | undefined;
	private readonly modelsStore: ModelsStore;
	private readonly overlay = new CatalogOverlaySource();
	private readonly userModels: UserModelsStore;
	private readonly officialCachePath: string | undefined;
	private lastCatalogRefresh: CatalogRefreshResult = { aborted: false, errors: new Map(), live: [], incomplete: [] };

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		allowModelNetwork: boolean,
		subscriptionManager: SubscriptionManager,
		catalogDir: string | undefined,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelsStore = modelsStore;
		this.allowModelNetwork = allowModelNetwork;
		this.subscriptionManager = subscriptionManager;
		this.userModels = new UserModelsStore(catalogDir ? userModelsPath(catalogDir) : undefined);
		this.officialCachePath = catalogDir ? officialCatalogCachePath(catalogDir) : undefined;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		// lunr: keep the underlying store — the SubscriptionManager mirrors rotated
		// keys into it directly, NOT through the RuntimeCredentials overlay (a runtime
		// --api-key override would shadow the mirror there).
		const baseStore = options.credentials ?? DefaultAuthStorage.create(options.authPath);
		const credentials = new RuntimeCredentials(baseStore);
		// Pool persistence: subscriptions.json next to auth.json. A custom credential
		// store without an authPath (tests, SDK embeddings) gets a process-local pool
		// so nothing leaks into the real agent dir.
		const subscriptionManager =
			options.subscriptions ??
			(options.credentials && !options.authPath
				? SubscriptionManager.inMemory(baseStore)
				: SubscriptionManager.create(
						baseStore,
						options.authPath ? join(dirname(options.authPath), "subscriptions.json") : undefined,
					));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const providers = builtinProviderCatalog.builtinProviders();
		const catalogDir = modelsPath ? dirname(modelsPath) : options.authPath ? dirname(options.authPath) : undefined;
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			options.allowModelNetwork ?? process.env.PI_OFFLINE === undefined,
			subscriptionManager,
			catalogDir,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		// lunr: create() must not wait on GitHub / provider /v1/models / a dead NIC.
		// Disk cache + baked-in + bundled official overlay are enough to start;
		// /refresh and the model picker still do a live refresh.
		await runtime.refresh({ allowNetwork: false });
		return runtime;
	}

	private configureRadiusProviders(): void {
		this.builtins.clear();
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	private providerIds(): Set<string> {
		return new Set([...this.builtins.keys(), ...this.config.getProviderIds(), ...this.extensionProviders.keys()]);
	}

	private recomposeProvider(providerId: string): void {
		const base = this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// No models.json/extension overlays: keep builtin auth/stream exact, then apply catalog layers.
			this.models.setProvider(this.withLocalCatalog(base));
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(this.withLocalCatalog(composeModelProvider(providerId, base, this.config, extension)));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(this.withLocalCatalog(base));
			else this.models.deleteProvider(providerId);
		}
	}

	private withLocalCatalog(provider: Provider): Provider {
		return isLiveListProvider(provider.id) ? withCatalogOverlay(provider, this.overlay) : provider;
	}

	private bakedInModels(providerId: string): Model<Api>[] {
		return [...(this.defaultBuiltins.get(providerId)?.getModels() ?? [])];
	}

	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async listStoredProviderIds(): Promise<Set<string>> {
		const credentials = await this.credentials.list();
		return new Set(credentials.map((entry) => entry.providerId));
	}

	/** `/model` lists stored creds + models.json/extension keys, never ambient envApiKeyAuth. */
	private configuredProviderIds(storedProviders: ReadonlySet<string>): Set<string> {
		const configured = new Set(storedProviders);
		for (const provider of this.models.getProviders()) {
			if (
				configuredRequestAuthStatus(this.config.getProvider(provider.id), this.extensionProviders.get(provider.id))
					?.configured
			) {
				configured.add(provider.id);
			}
		}
		return configured;
	}

	private userModelsForStoredProviders(storedProviders: ReadonlySet<string>): Model<Api>[] {
		return this.userModels
			.list()
			.filter((row) => storedProviders.has(row.provider))
			.map(userEntryToModel);
	}

	private async runAvailabilityRefresh(): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, storedProviders] = await Promise.all([
			this.models.getAvailable(),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id),
					],
				),
			),
			this.listStoredProviderIds(),
		]);
		const auth = new Map(checks);
		const configuredProviders = this.configuredProviderIds(storedProviders);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: available.filter((model) => configuredProviders.has(model.provider)),
			configuredProviders,
			storedProviders,
			auth,
		};
		this.availabilityError = undefined;
	}

	private queueAvailabilityRefresh(after: Promise<void> | undefined): Promise<void> {
		const refresh = (after ?? Promise.resolve()).catch(() => {}).then(() => this.runAvailabilityRefresh());
		const recorded = refresh.catch((error) => {
			this.availabilityError = error instanceof Error ? error.message : String(error);
			throw error;
		});
		const tracked = recorded.finally(() => {
			if (this.availabilityRefresh === tracked) this.availabilityRefresh = undefined;
		});
		this.availabilityRefresh = tracked;
		return tracked;
	}

	/** Coalesce concurrent readers onto the pending refresh. */
	private refreshAvailability(): Promise<void> {
		return this.availabilityRefresh ?? this.queueAvailabilityRefresh(undefined);
	}

	/** Mutations must not observe an in-flight refresh started before them. */
	private forceRefreshAvailability(): Promise<void> {
		return this.queueAvailabilityRefresh(this.availabilityRefresh);
	}

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId);
	}

	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		if (providerId) {
			if (this.availabilityRefresh) {
				await this.availabilityRefresh;
				return this.snapshot.available.filter((model) => model.provider === providerId);
			}
			try {
				return await this.models.getAvailable(providerId);
			} catch (error) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
				throw error;
			}
		}
		await this.refreshAvailability();
		return this.snapshot.available;
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...this.extensionProviders.keys()];
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	/** lunr: whether a runtime --api-key override is active for the provider (it shadows auth.json). */
	hasRuntimeApiKey(providerId: string): boolean {
		return this.credentials.hasRuntimeApiKey(providerId);
	}

	async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
		this.credentials.setRuntimeApiKey(providerId, apiKey);
		const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "runtime API key" });
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const storedProviders = new Set(this.snapshot.storedProviders).add(providerId);
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			storedProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async removeRuntimeApiKey(providerId: string): Promise<void> {
		this.credentials.removeRuntimeApiKey(providerId);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	/** lunr: whether network model-catalog fetches are allowed (offline mode disables them). */
	isNetworkAllowed(): boolean {
		return this.allowModelNetwork;
	}

	listCredentials(): Promise<readonly CredentialInfo[]> {
		return this.credentials.list();
	}

	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	private async prepareRequest(
		model: Model<Api>,
		options: (StreamOptions & ModelsStreamTransforms) | undefined,
	): Promise<{ provider: Provider; model: Model<Api>; options: StreamOptions }> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, { apiKey: options?.apiKey, env: options?.env });
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...providerOptions } = options ?? {};
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			},
		};
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsStreamTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const credential = await this.models.login(providerId, type, interaction);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
		return credential;
	}

	async logout(providerId: string): Promise<void> {
		await this.models.logout(providerId);
		await this.modelsStore.delete(providerId);
		this.userModels.evictProvider(providerId);
		this.overlay.setLive(providerId, []);
		// Reset credential-dependent compatibility projections before the unconfigured provider is skipped by refresh.
		this.recomposeProvider(providerId);
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async reloadConfig(): Promise<void> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		this.rebuildProviders();
		await this.refresh({ allowNetwork: this.allowModelNetwork });
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<CatalogRefreshResult> {
		const refreshOptions = {
			...options,
			allowNetwork: options.allowNetwork ?? this.allowModelNetwork,
		};
		const official = await this.refreshOfficialCatalog(refreshOptions.allowNetwork, refreshOptions.signal);
		const live = refreshOptions.allowNetwork
			? await this.refreshLiveCatalogs(
					official ? officialModelKeys(official.catalog) : new Set(),
					refreshOptions.signal,
				)
			: await this.restoreLiveCatalogs();

		// Radius / local-provider / extension refreshModels hooks. Live-list
		// providers have no refreshModels, so this does not hit pi.dev.
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		const errors = new Map(result.errors);
		for (const entry of live) {
			if (entry.status === "error" || entry.status === "timeout") {
				errors.set(entry.providerId, new Error(entry.error ?? entry.status));
			}
		}
		this.updateModelSnapshot();
		try {
			await this.forceRefreshAvailability();
		} catch {
			// Availability errors are recorded by forceRefreshAvailability; refreshed models remain usable.
		}
		const catalogResult: CatalogRefreshResult = {
			aborted: result.aborted,
			errors,
			official,
			live,
			incomplete: live.flatMap((entry) => entry.incomplete),
		};
		this.lastCatalogRefresh = catalogResult;
		return catalogResult;
	}

	getLastCatalogRefresh(): CatalogRefreshResult {
		return this.lastCatalogRefresh;
	}

	persistUserModels(rows: readonly UserModelEntry[]): void {
		this.userModels.upsert(rows);
		this.overlay.setUser(this.userModelsForStoredProviders(this.snapshot.storedProviders));
		this.updateModelSnapshot();
	}

	private async refreshOfficialCatalog(
		allowNetwork: boolean,
		signal?: AbortSignal,
	): Promise<(OfficialCatalogLoadResult & { evictedUserRows: number }) | undefined> {
		const storedProviders = await this.listStoredProviderIds();
		const loaded = await loadOfficialCatalog({
			allowNetwork,
			cachePath: this.officialCachePath,
			signal,
			providerIds: [...storedProviders],
		});
		const evicted = this.userModels.evictOfficial(officialModelKeys(loaded.catalog));
		const templateByProvider = new Map<string, Model<Api> | undefined>();
		const officialModels = loaded.catalog.models.map((entry) => {
			if (!templateByProvider.has(entry.provider)) {
				templateByProvider.set(entry.provider, this.bakedInModels(entry.provider)[0]);
			}
			return officialEntryToModel(entry, templateByProvider.get(entry.provider));
		});
		this.overlay.setOfficial(officialModels);
		this.overlay.setUser(this.userModelsForStoredProviders(storedProviders));
		return { ...loaded, evictedUserRows: evicted.length };
	}

	private async restoreLiveCatalogs(): Promise<LiveCatalogResult[]> {
		const storedProviders = await this.listStoredProviderIds();
		const results: LiveCatalogResult[] = [];
		for (const providerId of LIVE_LIST_PROVIDER_IDS) {
			const stored = storedProviders.has(providerId) ? await this.modelsStore.read(providerId) : undefined;
			if (stored?.models) this.overlay.setLive(providerId, stored.models);
			else this.overlay.setLive(providerId, []);
			results.push({
				providerId,
				status: "skipped",
				discoveries: [],
				added: 0,
				total: stored?.models.length ?? 0,
				incomplete: [],
			});
		}
		return results;
	}

	private async refreshLiveCatalogs(officialKeys: Set<string>, signal?: AbortSignal): Promise<LiveCatalogResult[]> {
		const storedProviders = await this.listStoredProviderIds();
		const known = knownModelKeys(
			LIVE_LIST_PROVIDER_IDS.flatMap((id) => this.bakedInModels(id)),
			officialKeys,
			this.userModels.keys(),
		);

		const results = await Promise.all(
			LIVE_LIST_PROVIDER_IDS.map(async (providerId) => {
				if (!storedProviders.has(providerId)) {
					this.overlay.setLive(providerId, []);
					return {
						providerId,
						status: "skipped" as const,
						discoveries: [],
						added: 0,
						total: 0,
						incomplete: [],
					};
				}

				const stored = await this.modelsStore.read(providerId);
				if (stored?.models) this.overlay.setLive(providerId, stored.models);
				if (signal?.aborted) {
					return {
						providerId,
						status: "skipped" as const,
						discoveries: [],
						added: 0,
						total: stored?.models.length ?? 0,
						incomplete: [],
						error: "aborted",
					};
				}

				const bakedIn = this.bakedInModels(providerId);
				const provider = this.models.getProvider(providerId) ?? this.defaultBuiltins.get(providerId);
				const baseUrl = provider?.baseUrl ?? bakedIn[0]?.baseUrl;
				if (!baseUrl) {
					return {
						providerId,
						status: "skipped" as const,
						discoveries: [],
						added: 0,
						total: 0,
						incomplete: [],
					};
				}

				const credential = await this.refreshCredentialFor(providerId);
				if (!credential) {
					return {
						providerId,
						status: "skipped" as const,
						discoveries: [],
						added: 0,
						total: stored?.models.length ?? 0,
						incomplete: [],
					};
				}

				const result = await fetchLiveProviderModels({
					providerId,
					baseUrl,
					bakedIn,
					credential,
					knownKeys: known,
					signal,
				});
				if (result.status === "ok") {
					const overlayModels = buildLiveOverlay(bakedIn, result.discoveries);
					this.overlay.setLive(providerId, overlayModels);
					try {
						await this.modelsStore.write(providerId, { models: overlayModels, checkedAt: Date.now() });
					} catch {
						// Store write is best-effort.
					}
				}
				return result;
			}),
		);
		return results;
	}

	private async refreshCredentialFor(providerId: string): Promise<Credential | undefined> {
		const stored = await this.credentials.read(providerId);
		if (stored?.type === "oauth" && stored.access) return stored;
		const resolved = await this.getAuth(providerId);
		if (resolved?.auth.apiKey) return { type: "api_key", key: resolved.auth.apiKey, env: resolved.env };
		if (stored?.type === "api_key" && stored.key) return stored;
		return undefined;
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// Provisional entry until the async refresh lands; never clobber a real check result.
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}
