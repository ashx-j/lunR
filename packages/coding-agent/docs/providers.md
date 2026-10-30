# Providers

lunR supports subscription-based providers via OAuth and API-key providers via environment variables or the auth file. Built-in catalogs ship with lunR. First paint is cache-only. `/model` lists stored-credential providers only. Run `/refresh` to pull newer catalogs; configured providers cache shards in `~/.lunr/agent/models-store.json` for offline use.

## Table of Contents

- [Subscriptions](#subscriptions)
- [API Keys](#api-keys)
- [Auth File](#auth-file)
- [Custom Providers](#custom-providers)
- [Resolution Order](#resolution-order)

## Subscriptions

Use `/login` in interactive mode, then select a provider:

- ChatGPT Plus/Pro (Codex)
- Claude Pro/Max
- GitHub Copilot
- xAI (Grok/X subscription)
- Radius

Use `/logout` to remove the lunR connection. Most subscription providers store refreshable tokens in `~/.lunr/agent/auth.json`. Anthropic uses a non-secret Claude Code connection record instead.

### OpenAI Codex

- Requires ChatGPT Plus or Pro subscription

### Claude Pro/Max

`/login anthropic` offers a Claude subscription connection that runs through a pinned Claude Code version. The first time, lunR asks before downloading that exact Claude Code build (about 100 MB) from the npm registry into `~/.lunr/agent/claude-code/<version>/`. The download must match a hash pinned in lunR's source, or nothing is installed. You do not need a separate Claude Code install, and lunR never changes another Claude Code on your machine.

lunR's copy uses Claude Code's normal sign-in, so an existing Claude Code login is reused. Otherwise, confirm the terminal handoff to `claude auth login` and pick a Claude subscription.

Claude Code owns your account session. lunR does not read its credentials or copy tokens into `auth.json`. For each generation, lunR builds the same Messages request it sends with an API key and starts one Claude Code process with its own tools turned off. Claude Code signs the request and sends it straight to Anthropic, so your sign-in never passes through lunR. lunR reads the answer from Claude Code's output and stops Claude Code once the answer is complete, so each generation is exactly one request. lunR still runs its own tools and manages history. `claude -p` runs, which is how lunR uses Claude Code, count against your plan's usage limits; see Anthropic's [Agent SDK plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) for current credits.

`/logout anthropic` removes only lunR's connection and cached provider models. Your Claude Code login stays, and so does the downloaded binary; delete `~/.lunr/agent/claude-code/` to remove it. `ANTHROPIC_OAUTH_TOKEN` does not work. Run `/login anthropic` instead. Genuine `ANTHROPIC_API_KEY` values continue using the Messages API. No subscription route falls back to direct OAuth.

The displayed token cost is an estimated API list-price equivalent, not a subscription bill or a remaining-plan meter. Models and routes come from Claude Code's model picker during setup, which lists what your plan offers. lunR skips variants that Claude Code bills from usage credits. A `[1m]` route gets a 1M context window, and every other model uses the window from lunR's model catalog. Setup sends nothing to Anthropic. New Claude models usually need a newer Claude Code: when lunR pins a newer one, `/refresh` says so, and `/login anthropic` downloads it and lists the new models.

### GitHub Copilot

- Press Enter for github.com, or enter your GitHub Enterprise Server domain
- If you get "model not supported", enable it in VS Code: Copilot Chat → model selector → select model → "Enable"

### xAI (Grok/X subscription)

- Run `/login xai`, then select **Use a subscription**
- `/login xai` can import the Grok CLI session from `~/.grok/auth.json` when lunR's own token is expired or after `invalid_grant`
- `/logout xai` does **not** delete `~/.grok/auth.json`
- `XAI_API_KEY` remains available through **Use an API key**

### Radius

Radius is a dynamic model gateway. `/login radius` stores OAuth tokens in `auth.json`; the gateway catalog is refreshed independently and cached in `models-store.json`. Custom Radius gateways can be declared in `models.json` with `"oauth": "radius"` and a gateway `baseUrl`.

### Local Ollama and LM Studio

`/login` includes local servers. Selecting Ollama or LM Studio probes localhost (3s timeout) and stores a dummy credential so the models appear in `/model`. If the server is offline, the model list refreshes empty and the provider becomes unavailable.

You can still add custom local entries in `~/.lunr/agent/models.json`; see [Custom Models](models.md).

### OpenCode Zen

`/login opencode` (or `OPENCODE_API_KEY`) then `/refresh`. Free rows rotate from live `/v1/models` intersected with models.dev.

## API Keys

### Environment Variables or Auth File

Use `/login` in interactive mode and select a provider to store an API key in `auth.json`, or set credentials via environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
lunr
```

| Provider | Environment Variable | `auth.json` key |
|----------|----------------------|------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| xAI | `XAI_API_KEY` | `xai` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Z.AI Coding Plan | `ZAI_API_KEY` | `zai` |
| Kimi For Coding | `KIMI_API_KEY` | `kimi-coding` |
| MiniMax | `MINIMAX_API_KEY` | `minimax` |
| OpenCode Zen | `OPENCODE_API_KEY` | `opencode` |
| Ollama Cloud | `OLLAMA_API_KEY` | `ollama-cloud` |

OpenCode Zen free models still require `/login opencode` (or `OPENCODE_API_KEY`). The free set rotates; `/refresh` after login pulls the official catalog shard.

Reference for environment variables and `auth.json` keys: [`const envMap`](https://github.com/ashx-j/lunR/blob/master/packages/ai/src/env-api-keys.ts) in [`packages/ai/src/env-api-keys.ts`](https://github.com/ashx-j/lunR/blob/master/packages/ai/src/env-api-keys.ts).

#### Auth File

Store credentials in `~/.lunr/agent/auth.json`:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "openai": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." },
  "google": { "type": "api_key", "key": "..." },
  "opencode": { "type": "api_key", "key": "..." }
}
```

The file is created with `0600` permissions (user read/write only). Auth file credentials take priority over environment variables.

API key credentials can also include provider-scoped environment values. These values are used before process environment variables when resolving the credential key, provider/model headers, and settings such as `PI_CACHE_RETENTION` and `HTTP_PROXY`/`HTTPS_PROXY`.

```json
{
  "openai": {
    "type": "api_key",
    "key": "$OPENAI_API_KEY",
    "env": {
      "OPENAI_API_KEY": "sk-...",
      "HTTPS_PROXY": "http://proxy.internal:8080"
    }
  }
}
```

Use this when lunR should use different provider settings than the project shell environment.

### Key Resolution

The `key` field supports command execution, environment interpolation, and literals:

- **Shell command:** `"!command"` at the start executes the whole value as a command and uses stdout (cached for process lifetime)
  ```json
  { "type": "api_key", "key": "!security find-generic-password -ws 'anthropic'" }
  { "type": "api_key", "key": "!op read 'op://vault/item/credential'" }
  ```
- **Environment interpolation:** `"$ENV_VAR"` or `"${ENV_VAR}"` uses the value of the named variable. Interpolation works inside larger literals.
  ```json
  { "type": "api_key", "key": "$MY_ANTHROPIC_KEY" }
  { "type": "api_key", "key": "${KEY_PREFIX}_${KEY_SUFFIX}" }
  ```
  `$FOO_BAR` is the variable `FOO_BAR`; use `${FOO}_BAR` when `BAR` is literal text. Missing environment variables make the value unresolved.
- **Escapes:** `"$$"` emits a literal `"$"`; `"$!"` emits a literal `"!"` without triggering command execution.
  ```json
  { "type": "api_key", "key": "$$literal-dollar-prefix" }
  { "type": "api_key", "key": "$!literal-bang-prefix" }
  ```
- **Literal value:** Used directly. Plain uppercase strings such as `MY_API_KEY` are literals; use `$MY_API_KEY` for environment variables.
  ```json
  { "type": "api_key", "key": "sk-ant-..." }
  { "type": "api_key", "key": "public" }
  ```

OAuth credentials are also stored here after `/login` and managed automatically.

## Custom Providers

**Via models.json:** Add Ollama, LM Studio, vLLM, or any provider that speaks a supported API (OpenAI Completions, OpenAI Responses, Anthropic Messages, Google Generative AI). Providers lunR does not ship, such as Groq, Mistral or Together AI, offer an OpenAI-compatible endpoint and work this way. `/login` also has a custom endpoint option that writes the `models.json` entry for you. See [models.md](models.md).

**Via extensions:** For providers that need custom API implementations or OAuth flows, create an extension. See [custom-provider.md](custom-provider.md) and [examples/extensions/custom-provider-gitlab-duo](../examples/extensions/custom-provider-gitlab-duo/).

## Resolution Order

When resolving credentials for a provider:

1. CLI `--api-key` flag
2. `auth.json` entry (API key or OAuth token)
3. Environment variable
4. Custom provider keys from `models.json`
