// @ts-nocheck
/**
 * MCP Auth Flow
 * 
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import {
  auth as runSdkAuth,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import open from "open"
import { McpOAuthProvider, type McpOAuthConfig, type McpOAuthFlowState } from "./mcp-oauth-provider.ts"
import {
  ensureCallbackServer,
  waitForCallback,
  cancelPendingCallback,
  acquireCallbackServerOwner,
  releaseCallbackServerOwner,
  releaseCallbackServer,
} from "./mcp-callback-server.ts"
import {
  getAuthForUrl,
  isTokenExpired,
  hasStoredTokens,
  clearAllCredentials,
  type StoredTokens,
} from "./mcp-auth.ts"
import { abortable, throwIfAborted } from "./abort.ts"
import type { ServerEntry } from "./types.ts"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

export interface AuthenticateOptions {
  onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>
}

/** Timeout for manual auth completion (5 minutes) */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Extract OAuth configuration from a ServerEntry.
 */
export function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
  if (definition.oauth === false) {
    return {}
  }

  const config: McpOAuthConfig = {}
  if (definition.oauth?.grantType !== undefined) config.grantType = definition.oauth.grantType
  if (definition.oauth?.clientId !== undefined) config.clientId = definition.oauth.clientId
  if (definition.oauth?.clientSecret !== undefined) config.clientSecret = definition.oauth.clientSecret
  if (definition.oauth?.scope !== undefined) config.scope = definition.oauth.scope
  if (definition.oauth?.redirectUri !== undefined) {
    if (typeof definition.oauth.redirectUri !== "string") {
      throw new Error("OAuth redirectUri must be a string")
    }
    const redirectUri = definition.oauth.redirectUri.trim()
    if (!redirectUri) {
      throw new Error("OAuth redirectUri must not be empty")
    }
    config.redirectUri = redirectUri
  }
  if (definition.oauth?.clientName !== undefined) {
    if (typeof definition.oauth.clientName !== "string") {
      throw new Error("OAuth clientName must be a string")
    }
    const clientName = definition.oauth.clientName.trim()
    if (!clientName) {
      throw new Error("OAuth clientName must not be empty")
    }
    config.clientName = clientName
  }
  if (definition.oauth?.clientUri !== undefined) {
    if (typeof definition.oauth.clientUri !== "string") {
      throw new Error("OAuth clientUri must be a string")
    }
    const clientUri = definition.oauth.clientUri.trim()
    if (!clientUri) {
      throw new Error("OAuth clientUri must not be empty")
    }
    config.clientUri = clientUri
  }
  return config
}

function parseOAuthRedirectUri(redirectUri: string): { port: number; callbackHost: string; callbackPath: string } {
  let url: URL
  try {
    url = new URL(redirectUri)
  } catch (error) {
    throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error })
  }

  const hostname = url.hostname.toLowerCase()
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI")
  }

  if (url.username || url.password) {
    throw new Error("OAuth redirectUri must not include username or password")
  }

  if (url.hash) {
    throw new Error("OAuth redirectUri must not include a fragment")
  }

  if (!url.port) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const port = Number.parseInt(url.port, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("OAuth redirectUri must include an explicit numeric port")
  }

  const callbackHost = hostname === "[::1]" ? "::1" : hostname
  return { port, callbackHost, callbackPath: url.pathname }
}

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
  try {
    const url = new URL(input)
    const params = new URLSearchParams(url.search)
    if (url.hash) {
      const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash
      const hashParams = new URLSearchParams(hash)
      for (const [key, value] of hashParams) {
        if (!params.has(key)) params.set(key, value)
      }
    }
    return params
  } catch {
    const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input
    const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query)
    return params.has("code") || params.has("state") || params.has("error") ? params : undefined
  }
}

/**
 * Extract an OAuth authorization code from either a raw code, a query string,
 * or the full localhost redirect URL copied from the browser address bar.
 */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Authorization code or redirect URL is required")
  }

  const params = getSearchParamsFromInput(trimmed)
  if (params) {
    const error = params.get("error")
    if (error) {
      const description = params.get("error_description")
      throw new Error(description ? `${error}: ${description}` : error)
    }

    const state = params.get("state")
    if (expectedState && !state) {
      throw new Error("OAuth state missing from redirect URL")
    }
    if (expectedState && state !== expectedState) {
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    const code = params.get("code")
    if (code) return code
  }

  if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) {
    return trimmed
  }

  throw new Error("Could not find an OAuth authorization code in the provided input")
}

interface PendingAuthFlow {
  state: McpOAuthFlowState
  controller: AbortController
  transport?: StreamableHTTPClientTransport
  timer?: ReturnType<typeof setTimeout>
  cleanup?: Promise<void>
}

/** Each session owns its flows; only the callback listener is shared. */
export function createMcpAuthFlow() {
  const owner = acquireCallbackServerOwner()
  const flows = new Map<string, PendingAuthFlow>()
  const authenticating = new Map<string, Promise<AuthStatus>>()
  let shutdownPromise: Promise<void> | undefined
  let closed = false

  function assertOpen(): void {
    if (closed) throw new Error("MCP OAuth session closed")
  }

  async function clearPendingAuth(serverName: string, flow = flows.get(serverName)): Promise<void> {
    if (!flow) return
    if (!flow.cleanup) {
      flow.cleanup = (async () => {
        if (flows.get(serverName) === flow) flows.delete(serverName)
        if (flow.timer) clearTimeout(flow.timer)
        flow.controller.abort(new Error("Authorization cancelled"))
        cancelPendingCallback(flow.state.oauthState)
        releaseCallbackServer(flow.state.oauthState)
        await flow.transport?.close().catch(() => {})
      })()
    }
    await flow.cleanup
  }

  async function startAuth(
    serverName: string,
    serverUrl: string,
    definition?: ServerEntry,
  ): Promise<{ authorizationUrl: string }> {
    assertOpen()
    const previous = flows.get(serverName)
    if (previous) await clearPendingAuth(serverName, previous)
    assertOpen()
    if (flows.has(serverName)) throw new Error(`OAuth flow already pending for server: ${serverName}`)
    const controller = new AbortController()
    const flow: PendingAuthFlow = { controller, state: { oauthState: generateState(), signal: controller.signal } }
    flows.set(serverName, flow)
    const signal = controller.signal
    const fetchFn: typeof fetch = (input, init) => fetch(input, {
      ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })
    try {
      const config = definition ? extractOAuthConfig(definition) : {}
      const storedAuth = await getAuthForUrl(serverName, serverUrl)
      throwIfAborted(signal)
      flow.state.clientInfo = storedAuth?.clientInfo
      // Reuse the registered redirect endpoint and client ID, including clients
      // without tokens. Display metadata changes never invalidate registrations.
      if (config.grantType !== "client_credentials") {
        if (!config.redirectUri && !config.clientId) {
          const registeredRedirect = storedAuth?.clientInfo?.redirectUris?.[0]
          if (registeredRedirect) config.redirectUri = registeredRedirect
        }
        const redirect = config.redirectUri ? parseOAuthRedirectUri(config.redirectUri) : undefined
        await ensureCallbackServer({
          owner,
          signal,
          strictPort: Boolean(config.clientId || storedAuth?.clientInfo) || config.redirectUri !== undefined,
          oauthState: flow.state.oauthState,
          reserveState: true,
          ...(redirect ? { port: redirect.port, callbackHost: redirect.callbackHost, callbackPath: redirect.callbackPath } : {}),
        })
        throwIfAborted(signal)
      }
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
        onRedirect: (url) => { throwIfAborted(signal); capturedUrl = url },
      }, flow.state)
      const result = await abortable(runSdkAuth(authProvider, { serverUrl, fetchFn }), signal)
      throwIfAborted(signal)
      if (result === "AUTHORIZED") {
        await clearPendingAuth(serverName, flow)
        return { authorizationUrl: "" }
      }
      if (config.grantType === "client_credentials" || !capturedUrl) {
        throw new UnauthorizedError("OAuth authorization URL was not provided")
      }
      flow.transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider, fetch: fetchFn })
      flow.timer = setTimeout(() => { void clearPendingAuth(serverName, flow) }, MANUAL_AUTH_TIMEOUT_MS)
      flow.timer.unref?.()
      return { authorizationUrl: capturedUrl.toString() }
    } catch (error) {
      await clearPendingAuth(serverName, flow)
      throw error
    }
  }

  async function completeAuthFromInput(serverName: string, input: string): Promise<AuthStatus> {
    assertOpen()
    const flow = flows.get(serverName)
    if (!flow) throw new Error(`No pending OAuth flow for server: ${serverName}`)
    return completeAuth(serverName, parseAuthorizationCodeInput(input, flow.state.oauthState))
  }

  async function completeAuth(serverName: string, code: string): Promise<AuthStatus> {
    assertOpen()
    const flow = flows.get(serverName)
    if (!flow?.transport) throw new Error(`No pending OAuth flow for server: ${serverName}`)
    try {
      await abortable(flow.transport.finishAuth(code), flow.state.signal)
      throwIfAborted(flow.state.signal)
      return "authenticated"
    } finally {
      await clearPendingAuth(serverName, flow)
    }
  }

  async function authenticate(
    serverName: string,
    serverUrl: string,
    definition?: ServerEntry,
    options: AuthenticateOptions = {},
  ): Promise<AuthStatus> {
    assertOpen()
    const pending = authenticating.get(serverName)
    if (pending) return pending
    const operation = (async (): Promise<AuthStatus> => {
      const { authorizationUrl } = await startAuth(serverName, serverUrl, definition)
      if (!authorizationUrl) return "authenticated"
      assertOpen()
      const flow = flows.get(serverName)
      if (!flow) throw new Error(`No pending OAuth flow for server: ${serverName}`)
      const callback = waitForCallback(flow.state.oauthState)
      // Attach a rejection handler before asynchronous UI/browser handoffs.
      void callback.catch(() => {})
      try {
        if (options.onAuthorizationUrl) {
          await abortable(Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), flow.state.signal)
        } else {
          console.log(`MCP Auth: Open this URL to authenticate ${serverName}:\n${authorizationUrl}`)
        }
        throwIfAborted(flow.state.signal)
        try {
          await abortable(open(authorizationUrl), flow.state.signal)
        } catch (error) {
          throwIfAborted(flow.state.signal)
          console.warn(`MCP Auth: Failed to open browser for ${serverName}; waiting for manual callback`, { error })
        }
        const code = await callback
        return await completeAuth(serverName, code)
      } catch (error) {
        await clearPendingAuth(serverName, flow)
        throw error
      }
    })()
    authenticating.set(serverName, operation)
    try { return await operation } finally {
      if (authenticating.get(serverName) === operation) authenticating.delete(serverName)
    }
  }

  async function removeAuth(serverName: string): Promise<void> {
    assertOpen()
    await clearPendingAuth(serverName)
    clearAllCredentials(serverName)
  }

  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      // Mark closed before cleanup can yield, so stale callers cannot start work.
      closed = true
      shutdownPromise = (async () => {
        await Promise.all([...flows].map(([name, flow]) => clearPendingAuth(name, flow)))
        await releaseCallbackServerOwner(owner)
      })()
    }
    return shutdownPromise
  }

  return { startAuth, completeAuth, completeAuthFromInput, authenticate, removeAuth, shutdown }
}

export type McpAuthFlow = ReturnType<typeof createMcpAuthFlow>

/**
 * Get a valid access token for a server, refreshing if necessary.
 * 
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
export async function getValidToken(
  serverName: string,
  serverUrl: string,
): Promise<StoredTokens | null> {
  // Check if we have valid tokens
  const entry = await getAuthForUrl(serverName, serverUrl)
  if (!entry?.tokens) {
    return null
  }

  // Check expiration
  const expired = await isTokenExpired(serverName)
  if (expired === false) {
    return entry.tokens
  }

  if (expired === true && entry.tokens.refreshToken) {
    // Token is expired, try to refresh
    console.log(`MCP Auth: Token expired for ${serverName}, attempting refresh`)

    try {
      // Create auth provider for token refresh
      const authProvider = new McpOAuthProvider(serverName, serverUrl, {}, {
        onRedirect: async () => {},
      })

      const clientInfo = await authProvider.clientInformation()
      if (!clientInfo) {
        console.log(`MCP Auth: No client info for refresh for ${serverName}`)
        return null
      }

      const result = await runSdkAuth(authProvider, { serverUrl })
      if (result !== "AUTHORIZED") {
        return null
      }
      const refreshed = await getAuthForUrl(serverName, serverUrl)
      return refreshed?.tokens ?? null
    } catch (error) {
      console.error(`MCP Auth: Token refresh failed for ${serverName}`, { error })
      return null
    }
  }

  // No expiration info or no refresh token, assume valid
  return entry.tokens
}

/**
 * Check the authentication status for a server.
 * 
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
  const hasTokens = await hasStoredTokens(serverName)
  if (!hasTokens) return "not_authenticated"

  const expired = await isTokenExpired(serverName)
  return expired ? "expired" : "authenticated"
}

/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 * 
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
export function supportsOAuth(definition: ServerEntry): boolean {
  // OAuth requires a URL
  if (!definition.url) return false
  
  // Explicitly disabled via auth: false or oauth: false
  if (definition.auth === false) return false
  if (definition.oauth === false) return false
  if (definition.auth === "oauth") return true
  
  // Configured custom headers take precedence over implicit OAuth auto-detection.
  if (definition.headers && Object.keys(definition.headers).length > 0) return false

  // OAuth is enabled when auth is not specified (auto-detect)
  return definition.auth === undefined
}
