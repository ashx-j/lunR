import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const idleParent = process.argv.includes('--idle');
const communicationMode = process.argv.includes('--communication');
fs.mkdirSync(path.join(root, '.artifacts'), { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lunr-question-smoke-'));
const home = path.join(profile, 'home');
const agentDir = path.join(home, '.lunr', 'agent');
const workspace = path.join(profile, 'workspace');
const temp = path.join(profile, 'temp');
for (const dir of [agentDir, workspace, temp]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(workspace, 'before.txt'), 'Initial investigation evidence.\n');
fs.writeFileSync(path.join(workspace, 'after.txt'), 'Original assignment continued after answering.\n');
let childReadyResolve, questionQueuedResolve;
const childReady = new Promise(r => { childReadyResolve = r; });
const questionQueued = new Promise(r => { questionQueuedResolve = r; });
let parentTurn = 0, childTurn = 0, runId, questionId, continuation = false, answerSeen = false, childFinished = false;
let handoffObservedResolve;
const handoffObserved = new Promise(r => { handoffObservedResolve = r; });
let handoffSeen = false, decisionSeen = false;
let failure;
const observations = [];
const textOf = body => JSON.stringify(body.messages);
const uuid = text => text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
function tool(res, name, args) {
  respond(res, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(16).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
function respond(res, delta, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'smoke' };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  try {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    observations.push({ model: body.model, messages: body.messages, tools: body.tools });
    const all = textOf(body);
    if (body.model === 'parent' && parentTurn === 0) {
      fs.writeFileSync(path.join(root, 'LUNR_SYSTEM_INJECTION.md'), body.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n'));
      fs.writeFileSync(path.join(root, '.artifacts', 'question-tool-inventory.json'), JSON.stringify(body.tools, null, 2));
    }
    if (communicationMode) {
      if (body.model === 'child') {
        if (childTurn++ === 0) {
          const contact = body.tools.find(t => t.function.name === 'contact_supervisor');
          assert(contact?.function.parameters.properties.reason.enum.includes('handoff'), 'Child lacks v2 handoff');
          childReadyResolve();
          return tool(res, 'contact_supervisor', { reason: 'progress_update', message: 'routine-progress-must-not-reach-parent' });
        }
        if (childTurn === 2) return tool(res, 'contact_supervisor', { reason: 'handoff', message: 'dependency-handoff-smoke-ok: use returned image pixels.' });
        if (childTurn === 3) {
          await handoffObserved;
          return tool(res, 'contact_supervisor', { reason: 'need_decision', message: 'blocked-decision-smoke-ok: native driver changes are outside my scope. Approve the scope change?' });
        }
        assert(all.includes('approved-decision-smoke-ok'), 'Child did not receive the decision reply');
        childFinished = true;
        return respond(res, { role: 'assistant', content: 'child-communication-completed: use returned image pixels; scope decision received.' });
      }
      assert(!all.includes('routine-progress-must-not-reach-parent'), 'UI-only progress leaked into parent context');
      if (parentTurn++ === 0) return tool(res, 'subagent', { task: 'Report progress, hand off the dependency contract, then request a scope decision and return a self-contained final report.', description: 'Communication smoke child', tier: 'light', permissions: 'read-only' });
      if (parentTurn === 2) {
        runId = uuid(JSON.stringify(body.messages.filter(m => m.role === 'tool').at(-1)));
        assert(runId, 'Missing async run id');
        await childReady;
        return respond(res, { role: 'assistant', content: 'Parent idle until actionable communication.' });
      }
      if (parentTurn === 3) {
        assert.equal(all.match(/dependency-handoff-smoke-ok/g)?.length, 1, 'Idle parent must receive exactly one handoff');
        handoffSeen = true;
        handoffObservedResolve();
        return respond(res, { role: 'assistant', content: 'Dependency received. Parent idle until decision request.' });
      }
      if (parentTurn === 4) {
        assert(all.includes('blocked-decision-smoke-ok'), 'Idle parent did not receive the blocking request');
        const request = body.messages.findLast(m => JSON.stringify(m.content).includes('blocked-decision-smoke-ok'));
        const requestId = uuid(JSON.stringify(request));
        assert(requestId, 'Decision request omitted reply id');
        decisionSeen = true;
        return tool(res, 'subagent_supervisor', { action: 'reply', replyTo: requestId, message: 'approved-decision-smoke-ok' });
      }
      if (parentTurn === 5) return tool(res, 'subagent_wait', { id: runId, timeoutMs: 20000 });
      assert(childFinished, 'Child did not receive the decision and finish');
      return respond(res, { role: 'assistant', content: 'parent-question-smoke-ok' });
    }
    if (body.model === 'child') {
      console.log(`child request ${childTurn}`);
      if (childTurn++ === 0) {
        for (const name of ['edit', 'write', 'code_rewrite']) {
          assert(!body.tools.some(t => t.function.name === name), `Read-only child exposes ${name}`);
        }
        childReadyResolve();
        await questionQueued;
        await new Promise(r => setTimeout(r, 800));
        return tool(res, 'read', { path: path.join(workspace, 'before.txt') });
      }
      if (childTurn === 2) {
        assert(all.includes(questionId), 'Child did not receive the queued question');
        assert(body.tools.some(t => t.function.name === 'contact_supervisor'), 'Child lacks reply tool');
        return tool(res, 'contact_supervisor', { action: 'reply', replyTo: questionId, message: 'answer-smoke-ok: existing evidence supports keeping the lock.' });
      }
      if (childTurn === 3) {
        continuation = true;
        return tool(res, 'read', { path: path.join(workspace, 'after.txt') });
      }
      assert(all.includes('Original assignment continued after answering.'), 'Child did not finish its original read');
      childFinished = true;
      return respond(res, { role: 'assistant', content: 'child-original-task-completed' });
    }
    console.log(`parent request ${parentTurn}`);
    if (parentTurn++ === 0) {
      fs.writeFileSync(path.join(root, '.artifacts', 'question-tool-inventory.json'), JSON.stringify(body.tools, null, 2));
      return tool(res, 'subagent', { task: 'Read before.txt, answer any parent question with current findings, then read after.txt and finish.', description: 'Async question smoke child', tier: 'light', permissions: 'read-only', async: true, artifacts: true });
    }
    if (parentTurn === 2) {
      const last = body.messages.filter(m => m.role === 'tool').at(-1);
      runId = uuid(JSON.stringify(last));
      assert(runId, `No async run id: ${JSON.stringify(last)}`);
      await childReady;
      return tool(res, 'subagent_supervisor', { action: 'ask', id: runId, index: 0, reason: 'Decide whether to keep the existing lock before changing the caller.', message: 'Does current evidence support keeping the existing lock?' });
    }
    if (parentTurn === 3) {
      const last = body.messages.filter(m => m.role === 'tool').at(-1);
      questionId = uuid(JSON.stringify(last));
      assert(questionId && questionId !== runId, `No question id: ${JSON.stringify(last)}`);
      questionQueuedResolve();
      if (idleParent) return respond(res, { role: 'assistant', content: 'Parent is doing no more work until the answer notification.' });
      return tool(res, 'subagent_wait', { questionId, timeoutMs: 20000 });
    }
    if (parentTurn === 4) {
      assert.equal(all.match(/answer-smoke-ok/g)?.length, 1, 'Parent must receive exactly one explicit answer');
      answerSeen = true;
      return tool(res, 'subagent_wait', { id: runId, timeoutMs: 20000 });
    }
    assert(childFinished, 'Child did not finish its original task');
    return respond(res, { role: 'assistant', content: 'parent-question-smoke-ok' });
  } catch (error) {
    failure = error;
    console.error(error);
    res.writeHead(500); res.end(String(error));
    child.kill();
  }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { smoke: { api: 'openai-completions', apiKey: 'local-smoke-placeholder', baseUrl, models: [{id:'parent',contextWindow:272000,maxTokens:4096},{id:'child',contextWindow:272000,maxTokens:4096}] } } }));
fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ smoke: { type: 'api_key', key: 'local-smoke-placeholder' } }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider:'smoke', defaultModel:'parent', defaultThinkingLevel:'off', defaultPermissionMode:'auto', modelTiers: { enabled:true, light:'smoke/child', standard:'smoke/child', heavy:'smoke/child' }, memoryEnabled:false, retry:{enabled:false}, compaction:{enabled:false} }));
const env = { ...process.env, HOME:home, USERPROFILE:home, APPDATA:home, LOCALAPPDATA:home, TEMP:temp, TMP:temp, TMPDIR:temp, PI_CODING_AGENT_DIR:agentDir, PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1' };
for (const key of Object.keys(env)) if (/^PI_SUBAGENT|^PI_INTERCOM|^PI_STARTUP_BENCHMARK/.test(key)) delete env[key];
const child = spawn(process.execPath, [path.join(root,'packages/coding-agent/dist/cli.js'), '--mode','json','--no-session','-p','--provider','smoke','--model','parent','Run the isolated parent-child question smoke.'], { cwd:workspace, env, stdio:['ignore','pipe','pipe'] });
let stdout='',stderr='', completed = false;
child.stdout.on('data', c => {
  stdout+=c;
  if (!completed && stdout.includes('parent-question-smoke-ok')) {
    completed = true;
    setTimeout(() => child.kill(), 500).unref();
  }
});
child.stderr.on('data', c => {stderr+=c;});
const deadline = setTimeout(() => { console.error('Smoke deadline reached'); child.kill(); }, 45000);
try {
  await once(child, 'exit');
  if (failure) throw failure;
  if (communicationMode) {
    assert(handoffSeen && decisionSeen && childFinished, 'Communication did not complete');
  } else {
    assert(answerSeen, 'No explicit answer observed');
    assert(continuation, 'Child did not continue original task');
  }
  assert(stdout.includes('parent-question-smoke-ok'), 'Parent did not complete');
  console.log(communicationMode ? 'PASS: UI-only progress excluded from every parent request; handoff and blocking decision woke idle parent; child received reply and finished.' : `PASS: real CLI, async read-only child, ${idleParent ? 'idle parent wake' : 'question wait'}, explicit reply, original task continued.`);
} finally {
  clearTimeout(deadline);
  const prefix = communicationMode ? 'communication-smoke' : idleParent ? 'question-idle-smoke' : 'question-smoke';
  fs.writeFileSync(path.join(root,'.artifacts',`${prefix}-observations.json`), JSON.stringify(observations,null,2));
  fs.writeFileSync(path.join(root,'.artifacts',`${prefix}-stdout.log`),stdout);
  fs.writeFileSync(path.join(root,'.artifacts',`${prefix}-stderr.log`),stderr);
  console.log(`Isolated profile: ${profile}`);
  server.closeAllConnections(); server.close();
  try {
    const brokerPid = Number(fs.readFileSync(path.join(agentDir, 'intercom', 'broker.pid'), 'utf8').trim());
    assert(Number.isSafeInteger(brokerPid) && brokerPid > 0, 'Invalid isolated broker pid');
    process.kill(brokerPid);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
}
