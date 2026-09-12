# lunR dev

This package contains development builds from lunR's `dev/tui` branch. The current baseline is stable lunR 0.2.19 plus the native computer-use changes from PR #77.

Computer use is experimental. Automated checks pass, but live desktop acceptance and macOS hardware verification remain incomplete. Stable `@ashx-j/lunr` is unchanged.

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

For computer use, run `/computer setup` in the local terminal. Windows x64/arm64 and Apple Silicon macOS receive only their matching optional runtime package. Keep optional dependencies enabled during installation. Screen and application content can enter model requests and saved sessions. GUI actions are outside file rollback.

See [computer-use setup and limitations](https://github.com/ashx-j/lunR/blob/dev/tui/packages/coding-agent/docs/computer-use.md).

For full documentation, see [the lunR README](https://github.com/ashx-j/lunR/blob/master/packages/coding-agent/README.md).
