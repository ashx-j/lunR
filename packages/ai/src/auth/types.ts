import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
	externalClaudeCode?: ExternalClaudeCodeCredential;
}

/**
 * Stored api-key credential. `env` holds provider-scoped environment/config
 * values such as Cloudflare account/gateway ids.
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** OAuth token data returned by extension compatibility flows. */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
}

/** Stored canonical OAuth credential. */
export interface OAuthCredential extends OAuthCredentials {
	type: "oauth";
}

/** A model Claude Code offers the account, as discovered at setup. */
export interface ClaudeCodeModelRoute {
	/** lunR model id: Claude Code's model id without its `[1m]` suffix. */
	id: string;
	/** `--model` value lunR passes to Claude Code, such as `claude-sonnet-5[1m]`. */
	route: string;
	/** Context window of that route. Absent when it is not a `[1m]` route, so the catalog window applies. */
	contextWindow?: number;
}

/**
 * Non-secret record of a Claude subscription connection. Claude Code owns the sign-in; lunR stores where
 * its pinned Claude Code binary lives and which models the account offers. Version 1 records came from the
 * retired Python bridge and version 2 records carry no routes or windows; both need /login anthropic again.
 */
export interface ExternalClaudeCodeCredential {
	type: "external_claude_code";
	version: 1 | 2 | 3;
	manager: "claude-code";
	/** Absolute path of the Claude Code binary. */
	command: string;
	/** Claude Code configuration directory override (`CLAUDE_CONFIG_DIR`). */
	configDir?: string;
	accountFingerprint?: string;
	/** Claude Code's picker order, so its default for the plan comes first. */
	models?: ClaudeCodeModelRoute[];
}

/** One type-tagged credential per provider — the shape of today's auth.json. */
export type Credential = ApiKeyCredential | OAuthCredential | ExternalClaudeCodeCredential;

/** Non-secret credential metadata for account/status enumeration. */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

/**
 * App-owned credential storage, keyed by `Provider.id`, one credential per
 * provider. `modify` is the only write path, so every mutation is a
 * serialized read-modify-write; `Models.getAuth()` runs OAuth refresh inside
 * `modify` so concurrent requests cannot double-refresh a rotated token. The
 * app persists a credential after login via
 * `modify(provider.id, async () => credential)`. Login/logout orchestration
 * is app-owned.
 *
 * Error semantics: `read` resolves `undefined` for missing entries. Methods
 * reject only on storage failure; `Models` wraps such rejections in
 * `ModelsError` with code "auth". Best-effort stores that serve an in-memory
 * view and record persistence errors internally (like coding-agent's
 * AuthStorage) are valid implementations.
 */
export interface CredentialStore {
	/**
	 * Read the stored credential, possibly expired. Display/status use;
	 * resolved request auth comes from `Models.getAuth()`.
	 */
	read(providerId: string): Promise<Credential | undefined>;

	/**
	 * List stored credential metadata without resolving or exposing secrets.
	 * Implementations must not execute configured API-key commands while listing.
	 */
	list(): Promise<readonly CredentialInfo[]>;

	/**
	 * Serialized write — the only write path. `fn` sees the current credential
	 * because correct writes (refresh, login-during-refresh) depend on it;
	 * return the new credential, or undefined to leave the entry unchanged.
	 * Mutual exclusion per provider id, cross-process too where the backing
	 * store supports it (e.g. a file lock). Resolves with the post-write
	 * credential. Rejections from `fn` propagate.
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined>;

	/** Remove a credential (logout). Implementations serialize this against `modify`. */
	delete(providerId: string): Promise<void>;
}

/** Environment access for auth resolution. Injectable for tests and browsers. */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
	/** Check whether a file exists. Supports a leading `~`. Always false in browsers. */
	fileExists(path: string): Promise<boolean>;
}

/** Result of resolving auth for a model. */
export interface AuthResult {
	auth: ModelAuth;
	/** Provider-scoped environment/config values resolved from credentials and ambient context. */
	env?: ProviderEnv;
	/** Human-readable label for status UI: "ANTHROPIC_API_KEY", "OAuth", "~/.aws/credentials". */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key" | "oauth";
}

export type AuthType = "api_key" | "oauth";

/**
 * Prompt shown to the user during login. `signal` lets the flow cancel a
 * pending prompt when an out-of-band event resolves the step, e.g. a
 * `manual_code` prompt raced against a callback server, aborted when the
 * callback wins.
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export interface AuthInfoLink {
	url: string;
	label?: string;
}

export type AuthEvent =
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

/**
 * Login interaction callbacks serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered/selected string (`select` returns the option
 * id). Rejects on cancel/abort. `signal` aborts the whole login flow;
 * per-prompt cancellation uses `AuthPrompt.signal`.
 */
export interface AuthInteraction {
	signal?: AbortSignal;

	prompt(prompt: AuthPrompt): Promise<string>;
	notify(event: AuthEvent): void;
	/** Interactive terminal handoff for external account login, never used by headless callers. */
	handoff?(command: string, args: readonly string[], env: Record<string, string>): Promise<void>;
}

/**
 * Api-key auth: stored key/provider env plus ambient sources (env vars, AWS
 * profiles, ADC files). Ambient-only providers omit `login`.
 */
export interface ApiKeyAuth {
	/** Display name, e.g. "Anthropic API key". */
	name: string;

	/** Interactive setup (prompt for key/provider env). Absent = ambient-only. */
	login?(interaction: AuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * Optional side-effect-free availability check. Use this when `resolve()` may
	 * execute commands or perform other request-time work. Missing means Models
	 * checks availability by resolving auth.
	 */
	check?(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthCheck | undefined>;

	/**
	 * Resolve auth from the stored credential and/or ambient sources, merging
	 * per field (`credential.key ?? env("...")`, `credential.env?.NAME ?? env("...")`).
	 * undefined = not configured. Resolution is provider-scoped; model-specific
	 * endpoint preparation happens after auth has been resolved.
	 */
	resolve(input: { ctx: AuthContext; credential?: ApiKeyCredential }): Promise<AuthResult | undefined>;
}

/**
 * OAuth auth. The `refresh`/`toAuth` split lets `Models` own the locked
 * refresh pattern: `refresh` produces a credential, `toAuth` derives request
 * auth from whatever credential ends up stored.
 */
export interface OAuthAuth {
	/** Display name, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;

	/** Selector label for the subscription login option, e.g. "Sign in with SuperGrok or X Premium". */
	loginLabel?: string;

	login(interaction: AuthInteraction): Promise<OAuthCredential | ExternalClaudeCodeCredential>;

	/**
	 * Exchange the refresh token. Network call; throws on failure
	 * (invalid_grant etc.). `Models` runs this under the store lock.
	 */
	refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;

	/**
	 * Side-effect-free derivation of request auth from a valid credential.
	 * Covers per-credential baseUrl (GitHub Copilot). Async so lazy wrappers
	 * can load the implementation on first use.
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider auth. At least one of `apiKey`/`oauth` must be present: even
 * ambient-credential providers and keyless local servers provide `apiKey`
 * auth whose `resolve()` reports whether the provider is configured.
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
	oauth?: OAuthAuth;
}
