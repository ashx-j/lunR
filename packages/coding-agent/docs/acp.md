# ACP clients

Run lunR inside T3 Code or another Agent Client Protocol client:

```sh
lunr --mode acp
```

In T3 Code, choose **Settings > Providers > Add provider > Local ACP command**.
Use `lunr` as the executable, with `--mode` and `acp` as two separate arguments.
The executable must be installed on the selected T3 environment's machine.
An absolute executable path also works.

For a development checkout, build the packages, then use executable `node`
with arguments `/absolute/path/to/lunR/packages/coding-agent/dist/cli.js`,
`--mode`, `acp`. This runs the checkout without replacing an installed CLI.

Configure model access in lunR's terminal interface first. ACP uses the same
credentials, model catalog, instructions, skills and enabled extensions, with
the ACP adjustments below.
There is no separate ACP login or model account. Optional CLI arguments such as
`--provider`, `--model`, `--thinking` and `--session-dir` apply to new workers.
Model and reasoning choices made in the client stay in the session journal;
they do not replace your saved terminal defaults. Launch arguments set defaults
for new sessions. Reopened sessions retain their saved model and reasoning.
The client owns prompts and session selection, so do not pass `--session`,
`--continue`, `--resume`, `--no-session` or a prompt on the command line.

## Supported behavior

The adapter negotiates ACP v1, including when a client initially requests v2.
It supports streamed replies and reasoning, tool activity and bounded file diffs,
images for models that accept them, text attachments, cancellation, model and
reasoning selection, and lunR's Build, Autonomous and Plan modes. These map to
lunR's existing `yolo`, `auto` and `read-only` modes.

Each session runs a separate lunR RPC process. Sessions use lunR's normal
journals. ACP records under `~/.lunr/agent/acp/sessions/` allow the client to
list, reopen and resume conversations. Closing a connection closes its workers;
it does not delete their conversations. Listing covers conversations created
through this adapter.

Mutating and unknown tools request permission through the client before they
execute. The client may approve automatically according to its own settings.
lunR's existing read-only restrictions remain in force. lunR also forwards plan
approval and large subagent launch approval to the client.

Approving a full-access subagent launch authorizes that child's tools without
individual ACP dialogs. The child retains lunR's normal permission inheritance.
The client sees the parent tool and its reported progress. lunR children do not
become native T3 child threads. The ACP turn stays open until owned background
children deliver their results and the parent finishes its follow-up.
Cancelling the session stops its owned background children too.

Clients that advertise ACP form elicitation can show extension questions and
text input. Other clients receive a chat notice and the dialog is cancelled.
During session startup, questions return their cancelled defaults because the
client has no active turn yet. A diagnostic appears in the worker log. Configure
extensions that require interactive startup in lunR's terminal interface first.
If a question expires or is cancelled internally after the client has opened
it, the turn stays open until you dismiss the dialog or stop the turn. ACP v1
does not let this adapter retract that host request. Late answers cannot resume
the cancelled operation.
Terminal-only widgets and custom terminal menus do not appear in the client.
Extension commands cannot replace the ACP session or navigate its conversation
history. The client owns those operations.

The client can supply stdio, HTTP or SSE MCP servers for each session. These
merge with lunR's configured servers, with client definitions taking precedence
for matching names. Their connection configuration and metadata cache stay in a
temporary worker directory, removed on normal shutdown. They are not saved in
your MCP configuration or inherited by lunR's subagents.

Audio, binary document attachments, additional workspace roots, conversation
rewind and ACP v2 are not advertised. Client-side filesystem and terminal APIs
are not required; lunR executes its own tools.

## Automatic ACP settings

ACP workers apply these settings for T3 and other ACP clients:

- New sessions start in **Build** mode, which allows questions. Mode changes in
  the client still work, and reopening a session restores its selected mode.
- **Automatic subagent delegation** guidance is off. Explicitly requested lunR
  subagents still work; they remain separate from T3's delegated tasks.
- lunR's **Browser**, **cron**, **goal loops** and **scheduled subagent runs** are
  disabled. Use the client's browser and scheduler through its MCP tools.
- **MCP** stays available, including servers supplied by the client.

The profile survives reloads and model changes without editing saved global,
project or subagent settings. Ordinary terminal sessions retain their settings.
Custom instructions and third-party extensions still control their own behavior.

No change to **Rollback** is needed. lunR's rollback runs only in its terminal
interface; ACP sessions use the client's checkpoint controls. T3's file
checkpoints do not rewind lunR's conversation history. Terminal appearance
settings have no effect on T3's interface.

Avoid duplicate manually configured T3 MCP servers. Keep normal project trust
rules; granting T3 access to a directory does not automatically trust its lunR
extensions.

## Upstream attribution

This adapter adapts the session/process design, ordered event translation,
prompt conversion and pre-edit snapshot approach from
[svkozak/pi-acp](https://github.com/svkozak/pi-acp), revision
`04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905`.
The original adapter is MIT licensed. Its [copyright and license](licenses/pi-acp.txt)
ship with lunR. The integration replaces Pi-specific settings, session lookup,
process launch and permission behavior with lunR's implementations. The ACP
SDK is pinned to the base adapter's reviewed `0.26.0` API.
