# Development

See [AGENTS.md](https://github.com/ashx-j/lunR/blob/master/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/ashx-j/lunR
cd lunR
npm install
npm run build
```

Compile in order: tui → ai → agent → coding-agent → orchestrator. The root build stays offline and does not regenerate the model catalog. From this repo, `npx lunr` uses the workspace CLI, not a published global install.

After changing coding-agent, run `npm --prefix packages/coding-agent run build`. Bare `tsgo` updates individual modules but leaves the Node bundle stale. The CLI and public SDK use shared chunks in `dist/node-runtime`; keep that directory with the rest of `dist` when packaging.

For startup measurements, import boundaries, and first-turn checks, read [Interactive startup](interactive-startup.md).

Run from the package:

```bash
npx lunr
```

lunR keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "piConfig": {
    "name": "lunr",
    "configDir": ".lunr"
  }
}
```

Change `name`, `configDir`, and `bin` for a fork. That affects the CLI banner and config directory. Environment variable names stay pinned: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SHARE_VIEWER_URL`. Do not invent `LUNR_*` replacements for those.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemesDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.lunr/agent/lunr-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
npx vitest --run                  # coding-agent tests
npm test -- test/specific.test.ts # specific test
```

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
