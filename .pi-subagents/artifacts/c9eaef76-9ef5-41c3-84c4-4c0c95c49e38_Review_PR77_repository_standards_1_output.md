**Standards review:** I found no confirmed violation of a documented repository rule in the 50-file PR diff.

Two judgement-call smells are worth noting:

- **Medium, type-safety risk:** `packages/coding-agent/src/builtin-extensions/lunr-computer-use.ts:116` converts schema-inferred parameters to `Record<string, unknown>`. `core/computer-use/workflow.ts:241` then accepts an unconstrained operation name and input. Runtime checks exist, but TypeScript cannot catch a schema-to-workflow mismatch.
- **Low, duplicated lifecycle logic:** `lunr-computer-use.ts:29`, `:42`, and `:166` each rebuild the active computer-tool roster. A future settings or session change could update one path but miss another. Current tests cover several transitions; I would not add an abstraction solely for this smell.

Inspection only. I ran no tests, builds, installations, driver calls, or desktop interactions. The existing untracked `.pi-subagents/` was untouched.