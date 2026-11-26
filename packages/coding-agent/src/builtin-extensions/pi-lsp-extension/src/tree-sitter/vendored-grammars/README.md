# Vendored tree-sitter grammars

`scripts/copy-tree-sitter-grammars.mjs` copies every grammar `parser-manager.ts` maps into one folder for the npm package and the standalone binary. It takes the file here when `manifest.json` lists it, and the `tree-sitter-wasms` file otherwise. Source runs and tests pick the same way. These six replace the `tree-sitter-wasms` 0.1.13 builds:

- The old TypeScript, TSX, JavaScript, Bash and C++ builds have lexers that V8 needs 0.6 to 2.2 GB to optimize, once per process, when a parse runs long enough to tier up.
- The old Lua build loops forever, growing wasm memory to its 2 GB limit, when it parses some text (`foo`, `def`) after earlier parses in the same process (of Lua, or of other grammars).

Each file is unchanged from the npm package `manifest.json` names, with its SHA-256. The five packages (six files) are MIT licensed; the notices are in `THIRD_PARTY_NOTICES`. All are ABI 14, the newest web-tree-sitter 0.24.7 loads. Newer releases are ABI 15.

`npm run check:vendored-grammars` (part of `check:ci`) fails when a file differs from its manifest hash. To refresh one, run `node scripts/vendored-grammars.mjs update <file.wasm> <package>@<version>`, for example `node scripts/vendored-grammars.mjs update tree-sitter-cpp.wasm tree-sitter-cpp@0.23.4`, then update `THIRD_PARTY_NOTICES` if the package changes.

No ABI 14 Swift build avoids the V8 problem (the lexer is over 400 KB in every build checked), so Swift has no grammar.
