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

For startup measurements, import boundaries, and first-turn checks, read [Interactive startup](https://github.com/ashx-j/lunR/blob/master/docs/agents/interactive-startup.md).

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

Change `name`, `configDir`, and `bin` for a fork. That affects the CLI banner and config directory. Environment variable names keep their `PI_` prefix: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemesDir } from "./config.ts";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.lunr/agent/lunr-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

Run these from `packages/coding-agent`:

```bash
npx vitest --run                       # all coding-agent tests
npx vitest --run test/specific.test.ts # one test file
```

From the repo root, `bash test.sh --workspace=packages/coding-agent -- test/specific.test.ts` runs the same tests with a disposable home directory and no inherited credentials.

Before committing, run `npm run check` from the repo root. The pre-commit hook runs it too.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
  orchestrator/ # Experimental orchestrator CLI
```
