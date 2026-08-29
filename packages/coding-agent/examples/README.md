# Examples

Example code for the lunR SDK (`@ashx-j/lunr`) and extensions.

After a global install, these files live under `node_modules/@ashx-j/lunr/examples` (or `npm root -g` then `@ashx-j/lunr/examples`). From this repo they are `packages/coding-agent/examples/`. Sample extensions such as `plan-mode`, `todo.ts`, and `subagent/` demonstrate the Extension API; they are not the product implementation.

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, extensions, and session management.

### [extensions/](extensions/)
Example extensions demonstrating:
- Lifecycle event handlers (tool interception, safety gates, context modifications)
- Custom tools (todo lists, questions, subagents, output truncation)
- Commands and keyboard shortcuts
- Custom UI (footers, headers, editors, overlays)
- Git integration (checkpoints, auto-commit)
- System prompt modifications and custom compaction
- External integrations (SSH, file watchers, system theme sync)
- Custom providers (Anthropic with custom streaming, GitLab Duo)

## Documentation

- [SDK Reference](sdk/README.md)
- [Extensions Documentation](../docs/extensions.md)
- [Skills Documentation](../docs/skills.md)
