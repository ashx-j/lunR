# Windows Setup

lunR requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.lunr/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Image paste

Ctrl+V is the terminal's paste. lunR image paste is **Alt+V**. The editor inserts `[image_n]` chips, not a temp path. VS Code may eat Alt+V (View mnemonic); forward it with `sendSequence` `\u001b[118;3u`.

## LSP

Language servers spawned through npm `.cmd` shims need a real process start on Windows. If an LSP never starts, tools silently fall back to tree-sitter. Check `/lsp` if language features look missing.
