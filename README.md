# lunR

A coding agent that runs in your terminal. You tell it what you want, and it reads, edits and runs the code in your project.

lunR is built on [pi](https://github.com/badlogic/pi-mono). It adds the things pi leaves to extensions, like subagents, MCP, permission modes, scheduled prompts and a Telegram or Discord bot.

You can use it with the subscription you already pay for, like Claude Pro or Max, ChatGPT Plus or Pro, GitHub Copilot or SuperGrok.

[![npm](https://img.shields.io/npm/v/@ashx-j/lunr?style=flat-square)](https://www.npmjs.com/package/@ashx-j/lunr)

## Install

You need Node.js 22.19 or newer.

```bash
npm i -g @ashx-j/lunr
cd your-project
lunr
```

The first launch walks you through signing in to a model provider.

## Docs

- [Full guide](packages/coding-agent/README.md) with commands, keys, settings and CLI options
- [Built-in features](packages/coding-agent/docs/features.md) for subagents, permission modes, cron and the gateway
- [Providers](packages/coding-agent/docs/providers.md) for signing in and API keys
- [Extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md) and [packages](packages/coding-agent/docs/packages.md)
- [Windows](packages/coding-agent/docs/windows.md), [Termux](packages/coding-agent/docs/termux.md) and [tmux](packages/coding-agent/docs/tmux.md) setup

## Uninstall

```bash
npm rm -g @ashx-j/lunr
```

Your settings, sign-ins and sessions stay in `~/.lunr/agent`. Run `lunr uninstall --purge` before removing the package to delete them too.

## Credits

lunR started as a fork of [pi](https://github.com/badlogic/pi-mono) by Mario Zechner. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) lists pi and the other projects lunR uses code from.

## License

[MIT](LICENSE)
