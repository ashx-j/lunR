# Security

lunR is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether lunR loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

lunR considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.lunr/settings.json`
- `.mcp.json`, `.lunr/mcp.json`, legacy `.pi/mcp.json`, or `.vscode/mcp.json`
- `.pi-lsp.json`
- `.lunr/extensions`, `.lunr/skills`, `.lunr/prompts`, or `.lunr/themes`
- `.lunr/SYSTEM.md` or `.lunr/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.lunr` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, lunR follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.lunr/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows lunR to load project resources that require trust, including:

- `.lunr/settings.json`
- `.lunr` resources such as extensions, skills, prompt templates, themes, and system prompt files
- project MCP servers and imports, and project LSP command overrides and eager startup
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, lunR only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Global retention settings control the global session tree. An approved project's retention settings apply only to its configured session directory. CLI and environment session-directory overrides remain explicit user choices.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

lunR does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the lunR process. The edit and write tools refuse lunR's own settings, credentials, memory and instruction files, but a shell command can still change them. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. lunR is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing lunR's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by lunR.

## Saved Logins

Tool calls never get lunR's own saved logins in the active profile: `auth.json`, `subscriptions.json` and the `mcp-oauth/` tree. Before any tool runs, lunR checks the call's string arguments, including strings inside arrays and objects. If one resolves to these locations, the call is refused. This applies to built-in, extension and MCP tools alike, in every permission mode, and covers relative paths, `..`, `~`, `@`, `file://` and symlinked directories. The `read` tool also refuses a symlink to one of them under another name. The refusal tells the model to ask you for a specific value.

A directory that contains them, such as the profile directory or your home directory, stays usable. lunR's own `grep`, `find`, `ast_search`, `code_rewrite` and `code_overview` skip the 3 locations while they walk it and say so in the result. `ls` and `find` list the profile directory. lunR can't know what an extension or MCP tool reads inside a directory you give it, so such a tool given the profile directory or a parent of it may still read these files.

The `bash` tool refuses a command that names one of the locations as a word, such as `cat ~/.lunr/agent/auth.json`, `jq . <auth.json` or `cd ~/.lunr/agent && cat auth.json`. `ls` of the profile directory works, but a command that names `mcp-oauth` itself is refused, as it is for the `ls` tool.

This stops an accidental read, or a web page telling the model to read the files. It is not a sandbox. Bash still reads them through:

- a variable (`cat "$HOME/.lunr/agent/auth.json"`), a glob (`cat ~/.lunr/agent/a*.json`) or a script
- a symlink or hard link under another name (`cat notes.json` where `notes.json -> auth.json`)
- a command that reads the whole profile directory, such as `grep -r`, `find -exec cat`, `tar` or `cp -r`
- a relative name after a directory change bash can't be read from the command text, such as `cd "$D"`, `pushd` or `cd -`
- a symlink to a directory inside `mcp-oauth/`, used by a path that doesn't name `mcp-oauth`

The guard covers tool calls the model makes. Text you add yourself, such as `@~/.lunr/agent/auth.json` in a prompt, goes to the model as you wrote it. With `MCP_OAUTH_DIR` set, the MCP tokens live outside the profile and are not covered. Other secrets on the machine, such as `~/.ssh`, `.env` files and cloud credentials, are not covered either. lunR itself (login, `lunr doctor`) reads the files directly and is not affected.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run lunr in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `lunr` process inside a container/sandbox
- run host lunR while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.lunr/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Reporting Security Issues

To report a security issue, use a [private GitHub security advisory](https://github.com/ashx-j/lunR/security/advisories/new) on [ashx-j/lunR](https://github.com/ashx-j/lunR). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how lunR grants access that the local user did not already have.
