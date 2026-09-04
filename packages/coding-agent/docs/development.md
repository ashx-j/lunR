# Development

See [AGENTS.md](https://github.com/ashx-j/lunR/blob/master/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/ashx-j/lunR
cd lunR
npm install
npm run build
```

Compile in order: tui → ai → agent → coding-agent. From this repo, `npx lunr` is the workspace bin (`packages/coding-agent/dist/cli.js`), not a published global install. Rebuild coding-agent `dist` after changes.

Run from the package:

```bash
npx lunr
```

lunR keeps the caller's current working directory.

## TUI dev channel

Every push to `dev/tui` builds and publishes `@ashx-j/lunr-dev`. The workflow does not run tests. If the code does not compile, npm keeps serving the previous dev build.

Install it once:

```bash
npm i -g @ashx-j/lunr-dev
```

Run the stable and dev versions with separate commands:

```bash
lunr
lunr-dev
```

After a new dev build publishes, update and run it:

```bash
lunr-dev update
lunr-dev
```

The dev CLI has its own npm package and executable, so installing it does not replace `lunr`. It uses the same `~/.lunr/agent` data as stable lunR. Existing logins and settings work in both versions, but a broken dev change can modify shared settings or sessions.

Remove only the dev CLI with:

```bash
npm uninstall -g @ashx-j/lunr-dev
```

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
