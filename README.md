# lunR

CLI coding agent. Config lives in `~/.lunr/`.

## Install

Node.js 22.19 or newer.

```bash
npm i -g @ashx-j/lunr
lunr
```

Then in the TUI: `/login`.

Optional features (Discord / Telegram gateway):

```bash
lunr setup
```

## Uninstall

```bash
npm rm -g @ashx-j/lunr
```

Sessions and keys stay in `~/.lunr/agent` unless you also run `lunr uninstall --purge --yes` before removing the package.
