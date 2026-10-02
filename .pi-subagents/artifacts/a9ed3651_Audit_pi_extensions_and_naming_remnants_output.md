Both findings reproduced against source in the clean `b57c148` worktree. No edits or builds.

**LSP listener accumulation.** The source factory mock reported `0` listeners before registration, `1` after registration, `1` after `session_shutdown`, and `2` after a second registration. A separate child process threw the sentinel exception. It printed `survived-uncaught` and exited **0**; stderr logged `[LSP] Uncaught exception: Error: isolated sentinel`. The parent process did not throw.

```lunr-copy
cd /c/Users/ash/Desktop/PROJECTS/lunR-review-audit && node --import tsx --input-type=module -e 'import lspExtension from "./packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/index.ts"; const callbacks={}; const pi={registerTool(){},registerCommand(){},on(k,f){callbacks[k]=f},events:{on(){}}}; const n=process.listenerCount("uncaughtException"); lspExtension(pi); console.log(JSON.stringify({before:n,afterFactory:process.listenerCount("uncaughtException")})); await callbacks.session_shutdown(); console.log(JSON.stringify({afterShutdown:process.listenerCount("uncaughtException")})); lspExtension(pi); console.log(JSON.stringify({afterSecondFactory:process.listenerCount("uncaughtException")}));'
```

```lunr-copy
cd /c/Users/ash/Desktop/PROJECTS/lunR-review-audit && node --input-type=module -e 'import {spawnSync} from "node:child_process"; const code=`import lspExtension from "./packages/coding-agent/src/builtin-extensions/pi-lsp-extension/src/index.ts"; lspExtension({registerTool(){},registerCommand(){},on(){},events:{on(){}}}); process.nextTick(()=>{throw new Error("isolated sentinel")}); setTimeout(()=>console.log("survived-uncaught"),20);`; const result=spawnSync(process.execPath,["--import","tsx","--input-type=module","-e",code],{cwd:process.cwd(),encoding:"utf8",timeout:10000}); console.log(JSON.stringify({status:result.status,signal:result.signal,stdout:result.stdout.trim(),stderr:result.stderr.trim()}));'
```

**`/chain-prompts` collision.** Mock registration through both source modules, followed by the actual `ExtensionRunner` command resolver, produced `["chain-prompts:1","chain-prompts:2"]`. `getCommand("chain-prompts")` returned `null`.

```lunr-copy
cd /c/Users/ash/Desktop/PROJECTS/lunR-review-audit && PI_CODING_AGENT_DIR='C:/Users/ash/AppData/Local/Temp/lunr-audit-nonexistent-profile' node --import tsx --input-type=module -e 'import promptModelExtension from "./packages/coding-agent/src/builtin-extensions/pi-prompt-template-model/index.ts"; import {registerPromptWorkflowCommands} from "./packages/coding-agent/src/builtin-extensions/pi-subagents/src/slash/prompt-workflows.ts"; import {ExtensionRunner} from "./packages/coding-agent/src/core/extensions/runner.ts"; const mk=(name)=>{const commands=new Map(); return {name,commands,api:{registerMessageRenderer(){},registerTool(){},registerCommand(key,opts){commands.set(key,{name:key,...opts})},on(){}}}}; const old=mk("pi-prompt-template-model"); const newer=mk("pi-subagents"); promptModelExtension(old.api); registerPromptWorkflowCommands({pi:newer.api,run:async()=>{}}); const runner=Object.create(ExtensionRunner.prototype); runner.extensions=[old,newer]; console.log(JSON.stringify({registered:[...old.commands.keys(),...newer.commands.keys()],resolved:runner.getRegisteredCommands().filter(command=>command.name==="chain-prompts").map(command=>command.invocationName),plainLookup:runner.getCommand("chain-prompts")?.invocationName??null}));'
```

The earlier focused test command was:

```lunr-copy
cd /c/Users/ash/Desktop/PROJECTS/lunR-review-audit/packages/coding-agent && npx --no-install vitest --run test/lsp-extension-startup.test.ts test/prompt-templates.test.ts
```

It passed **104/104** tests. These are source/mock reproductions, not a compiled-current CLI check; linked dependencies may resolve older `dist` files.