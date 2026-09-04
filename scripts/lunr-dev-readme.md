# lunR dev

This package contains untested builds from lunR's `dev/tui` branch. Use it to try TUI changes before they reach the stable `@ashx-j/lunr` package.

Install it once:

```bash
npm i -g @ashx-j/lunr-dev
```

Run it with:

```bash
lunr-dev
```

Pull the newest published build with:

```bash
lunr-dev update
```

Stable lunR remains available as `lunr`. Both commands use `~/.lunr/agent`, so they share credentials, settings, and sessions.

For full documentation, see [the lunR README](https://github.com/ashx-j/lunR/blob/master/packages/coding-agent/README.md).
