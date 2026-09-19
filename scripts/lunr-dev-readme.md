# lunR dev

This package contains development builds from lunR's `dev/tui` branch. This integration combines stable lunR 0.2.21 with image-only computer use from PR #77's continuation.

Computer use is experimental. Observations use bounded screenshots instead of accessibility trees, with crop mapping and one action plus a post-action image. Source-review fixes cover equivalent clicks, discovery pagination, and partial typing recovery. Offline builds, 265 focused tests, local scripted-provider startup checks, and isolated package installation pass. No native runtime launch, live desktop capture/input, or remote inference ran. Smooth cursor animation is not included; live desktop and macOS hardware acceptance remain pending. Stable `@ashx-j/lunr` is unchanged.

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
