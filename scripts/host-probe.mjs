import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, relative } from 'node:path';
const runtimeRoot = resolve(process.argv[2] ?? '.');
const version = process.argv[3] ?? '0.2.2-rc.1';
const require = createRequire(resolve(runtimeRoot, 'package.json'));
const load = name => {
  const path = require.resolve(name);
  if (relative(runtimeRoot, path).startsWith('..')) throw new Error(`Host isolation violation: ${name}`);
  return import(pathToFileURL(path).href);
};
const optional = async name => { try { return await load(name); } catch (error) { if (error.code === 'MODULE_NOT_FOUND' || String(error).includes('Host isolation violation:')) return undefined; throw error; } };
const [{ Context }, llm, sessions, projections, prompt, tools, agents, loop, stabilizer] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'),
  optional('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'),
  process.argv[4] ? import(pathToFileURL(resolve(process.argv[4])).href) : import('../dist/index.js'),
]);
const ctx = new Context();
let current, pluginFiber;
const bound = promise => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host probe timed out')), 15000); })]).finally(() => clearTimeout(timer));
};
const checks = [];
try {
  for (const service of [llm.default, sessions.default, projections?.default, prompt.default, tools.default, agents.default, loop.default].filter(Boolean)) {
    const options = service === prompt.default ? { personaPrefix: '', personaSuffix: '' } : service === loop.default ? { agents: [] } : {};
    await ctx.plugin(service, options);
  }
  if (typeof ctx.tools.setExecutor === 'function') {
    const native = await load('@deepseek-ai/dsh-tool-executor-native'); await ctx.plugin(native);
  }
  let response = 'normal', requests = 0, toolBodies = 0, correctionsSeen = 0, guardClosed = false, guardConsumed = 0;
  let reviewReady, reviewResume, queuedStep = 0, scenarioChars = 0;
  let recoveryStep = 0, sawRecoveredToolResult = false, waitingReady;
  const turnReasons = [];
  ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') turnReasons.push(event.data.reason.kind); });
  const hostHint = process.argv[4] ? {} : { hostVersion: version };
  const raw = [];
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      requests++;
      if (options.messages.some(m => m.role === 'user' && m.content?.some(c => c.type === 'text' && c.text.includes('检测到当前步骤出现重复推理。')))) correctionsSeen++;
      assert.ok(['deepseek-flash', 'vendor/DeepSeek-Custom:fast'].includes(options.model), 'deterministic fixture model');
      if (['checklist', 'named-checklist', 'path-checklist', 'dense-checklist', 'dense-named-checklist', 'fenced-loop', 'inline-fence-loop', 'body-loop', 'single-letter', 'single-body', 'tool-then-single', 'fixed-number-phrase', 'queued-steering', 'queued-followup'].includes(response)) {
        if (response === 'tool-then-single' && ++queuedStep === 1) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'before-single-loop', name: 'read_evidence', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        assert.ok(response !== 'tool-then-single' || queuedStep === 2, 'bounded post-tool loop test');
        const queued = response.startsWith('queued-');
        if (queued && ++queuedStep === 2) {
          assert.ok(options.messages.some(message => message.content?.some(block => block.type === 'text' && block.text === 'Handle queued user input.')));
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Queued input handled.' } };
          yield { type: 'finish', reason: { kind: 'stop' } }; return;
        }
        assert.ok(!queued || queuedStep === 1, 'bounded queued input test');
        const blocks = response === 'checklist' ? [{ type: 'reasoning', text: Array.from({ length: 100 }, (_, i) => `项目 ${i}。检查。通过。保留。\n`).join('') }]
          : response === 'named-checklist' ? [{ type: 'reasoning', text: Array.from({ length: 200 }, (_, i) => `模块 ${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}。检查。通过。保留。\n`).join('') }]
          : response === 'path-checklist' ? [{ type: 'reasoning', text: Array.from({ length: 200 }, (_, i) => `src/${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}.ts。检查。通过。检查。通过。\n`).join('') }]
          : response === 'dense-checklist' || response === 'dense-named-checklist' ? [{ type: 'reasoning', text: Array.from({ length: 200 }, (_, i) => `${response === 'dense-checklist' ? `项目 ${i}` : `模块 ${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`}。检查。通过。保留。无误。检查。通过。\n`).join('') }]
          : response === 'fenced-loop' || response === 'inline-fence-loop' ? [{ type: 'reasoning', text: ('好。执行。好。'.repeat(40) + (response === 'fenced-loop' ? '\n```ts\nconst a = 1;\n```\n' : '\n```inline```\n')).repeat(20) }]
          : ['single-letter', 'single-body', 'tool-then-single'].includes(response) ? [{ type: response === 'single-body' ? 'text' : 'reasoning', text: '好。'.repeat(17233) }]
          : response === 'fixed-number-phrase' ? [{ type: 'reasoning', text: Array.from({ length: 180 }, (_, i) => `步骤 1 已确认。核对 v2 接口。\n${i % 9 === 0 ? '（备注）再核对一次。\n' : ''}`).join('') }]
          : response === 'body-loop' ? [{ type: 'text', text: 'Template line, repeat as requested. '.repeat(200) }, { type: 'reasoning', text: '检查。继续。'.repeat(1000) }]
            : [{ type: 'reasoning', text: '检查。继续。'.repeat(1000) }];
        scenarioChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
        for (const [index, block] of blocks.entries()) {
          yield { type: 'block-start', index, blockType: block.type };
          if (queued) { reviewReady(); await reviewResume.promise; }
          for (let offset = 0; offset < block.text.length; offset += 73) {
            options.signal.throwIfAborted();
            yield { type: block.type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index, text: block.text.slice(offset, offset + 73) };
          }
          yield { type: 'block-end', index, block };
        }
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      if (response === 'guard') {
        const text = Array.from({ length: 400 }, (_, i) => `检查。继续。\n${i % 9 === 0 ? `（备注 ${i}）再看一次。\n` : ''}`).join('');
        try {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' };
          for (let offset = 0; offset < text.length; offset += 73) {
            options.signal.throwIfAborted(); guardConsumed += Math.min(73, text.length - offset);
            yield { type: 'reasoning-delta', index: 0, text: text.slice(offset, offset + 73) };
          }
          throw new Error('Guard failed to stop the repetitive stream');
        } finally { guardClosed = true; }
      }
      if (response === 'max-tools') {
        recoveryStep++;
        if (recoveryStep === 2) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'recovery-read', name: 'read_evidence', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
        if (recoveryStep === 3) {
          // Older hosts carry tool-result blocks in user-role messages; newer
          // hosts use first-class tool messages. Verify correlation AND value.
          const results = options.messages.flatMap(message => {
            if (message.source?.kind !== 'tool' || message.source.callId !== 'recovery-read') return [];
            if (message.role === 'tool' && message.toolCallId === 'recovery-read') return [message];
            if (message.role === 'user') return message.content.filter(block => block.type === 'tool-result' && block.toolCallId === 'recovery-read');
            return [];
          });
          sawRecoveredToolResult = results.some(result => !result.isError && result.content.some(block => block.type === 'text' && block.text === 'same evidence'));
        }
        assert.ok(recoveryStep <= 3, 'bounded max-token recovery');
      }
      if (response === 'tools' && toolBodies < 4) {
        const call = { type: 'tool-call', id: `call-${requests}`, name: 'read_evidence', arguments: '{}' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const content = response === 'repeat' || response === 'waiting' || response === 'max-tools' && recoveryStep === 1
        ? '现在需要继续分析这个问题并确认下一步必要操作。'.repeat(200) : '任务完成，已有证据。';
      const chunks = [{ type: 'block-start', index: 0, blockType: 'reasoning' }];
      for (let i = 0; i < content.length; i += 97) chunks.push({ type: 'reasoning-delta', index: 0, text: content.slice(i, i + 97) });
      chunks.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: content } });
      chunks.push({ type: 'text-delta', index: 1, text: '完成。' });
      chunks.push({ type: 'usage', usage: { inputTokens: 12, outputTokens: 15 } });
      chunks.push({ type: 'finish', reason: { kind: response === 'max-tools' && recoveryStep === 1 ? 'max-tokens' : 'stop' } });
      for (const chunk of chunks) {
        raw.push(chunk); yield chunk;
        if (response === 'waiting' && chunk.type === 'block-end') {
          waitingReady?.();
          await new Promise(resolve => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          options.signal.throwIfAborted();
        }
      }
    }
  }
  ctx.llm.registerAdapter(['mock', 'mock-alt'], new Adapter());
  const seen = [];
  ctx.on('llm/stream', (_options, next) => (async function* () { for await (const chunk of next()) { seen.push(chunk); yield chunk; } })());
  pluginFiber = ctx.plugin(stabilizer, { ...hostHint, mode: 'observe' });
  await pluginFiber;
  assert.notEqual(ctx.get('flashStabilizer'), undefined, 'plugin activation');
  if (process.argv[4]) {
    assert.equal(ctx.flashStabilizer.status().compatibility.version, version, 'packaged plugin resolves the actual host version');
    checks.push('packaged-host-detection');
  }
  current = await ctx.agentLoop.create(sessions.SessionId(`probe-${version}`), { provider: 'mock', model: 'deepseek-flash' });
  const send = async () => { current.followup(llm.createUserMessage({ content: [{ type: 'text', text: '继续任务' }], source: { kind: 'user' } })); await bound(current.whenIdle()); };
  await send();
  assert.equal(ctx.flashStabilizer.status().counts['stream-repeat'] ?? 0, 0); checks.push('normal-output');
  response = 'repeat'; await send();
  assert.ok(ctx.flashStabilizer.status().counts['stream-repeat'] >= 1, 'loop detection'); checks.push('reasoning-loop');
  assert.deepEqual(seen, raw); checks.push('lossless-chunks');
  ctx.tools.register({ name: 'read_evidence', description: 'Read deterministic evidence', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { toolBodies++; return 'same evidence'; },
  });
  response = 'tools'; await send();
  assert.equal(toolBodies, 4, 'plugin must not skip/replay tool calls');
  assert.ok(ctx.flashStabilizer.status().counts['tool-repeat'] >= 1, 'tool repetition detection'); checks.push('tool-results');
  const originalAgent = current;
  const customRoute = { provider: 'mock', model: 'vendor/DeepSeek-Custom:fast' };
  current = await ctx.agentLoop.create(sessions.SessionId(`custom-model-${version}`), customRoute);
  response = 'repeat'; await send();
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).confirmed, 1, 'default scope includes third-party model names');
  checks.push('default-third-party-model');
  await ctx.flashStabilizer.setModelScope({ scope: 'selected', selections: [customRoute] });
  current = await ctx.agentLoop.create(sessions.SessionId(`excluded-provider-${version}`), { ...customRoute, provider: 'mock-alt' });
  await send();
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).monitoredRequests, 0, 'same model on an unselected provider is excluded');
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).coverage, 'other-model');
  checks.push('scope-provider-isolation');
  await ctx.flashStabilizer.setModelScope({ scope: 'all', selections: [customRoute] });
  await send();
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).confirmed, 1, 'restoring all includes the next request');
  assert.deepEqual(ctx.flashStabilizer.modelScope().selections, [customRoute], 'all mode preserves selections');
  checks.push('scope-restored-all');
  await ctx.flashStabilizer.setModelScope({ scope: 'selected', selections: [customRoute] });
  current = await ctx.agentLoop.create(sessions.SessionId(`selected-model-${version}`), customRoute);
  await send();
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).confirmed, 1, 'selected provider/model is monitored');
  checks.push('scope-selected-model');
  await ctx.flashStabilizer.setModelScope({ scope: 'all', selections: [] });
  current = originalAgent;
  response = 'waiting';
  const observeReady = new Promise(resolve => { waitingReady = resolve; });
  const observeStopped = send(); await bound(observeReady);
  current.cancel({ kind: 'user' }); await observeStopped;
  const observed = ctx.flashStabilizer.sessionStatus(current.id);
  assert.equal(observed.live.risk, 'confirmed', 'manual stop retains confirmed evidence');
  assert.equal(observed.live.incomplete, false, 'manual stop is not a detector failure');
  assert.equal(observed.latestEvent.kind, 'stream-repeat');
  assert.equal(observed.latestEvent.action, 'observe-only');
  checks.push('observe-user-stop-evidence');
  const before = ctx.flashStabilizer.status().counts['stream-repeat'];
  ctx.flashStabilizer.setSessionEnabled(current.id, false); response = 'repeat'; await send();
  assert.equal(ctx.flashStabilizer.status().counts['stream-repeat'], before); checks.push('session-disable');
  await pluginFiber.dispose();
  assert.equal(ctx.get('flashStabilizer'), undefined);
  await send(); checks.push('unload');
  pluginFiber = ctx.plugin(stabilizer, { ...hostHint, mode: 'assist' }); await pluginFiber;
  const beforeAssist = requests, beforeTools = toolBodies;
  await send();
  assert.equal(requests - beforeAssist, 3, 'assist is limited to two extra turns');
  assert.equal(ctx.flashStabilizer.status().counts.recovery, 5, 'two deferrals, two followups, exhausted budget');
  assert.equal(toolBodies, beforeTools, 'assist never replays tools');
  assert.ok(correctionsSeen >= 2, 'correction reaches actual subsequent model requests');
  const beforeReset = requests;
  await send(); assert.equal(requests - beforeReset, 3, 'new user input resets assist budget');
  checks.push('assist-delivery', 'assist-budget', 'new-user-budget-reset');
  const beforeMax = requests, beforeMaxTools = toolBodies, beforeMaxTurns = turnReasons.length;
  response = 'max-tools'; await send();
  assert.equal(requests - beforeMax, 3, 'model continues after recovered tool execution');
  assert.equal(toolBodies - beforeMaxTools, 1, 'recovery executes the requested tool exactly once');
  assert.equal(sawRecoveredToolResult, true, 'model sees the recovered tool result');
  assert.deepEqual(turnReasons.slice(beforeMaxTurns), ['max-tokens', 'completed']);
  checks.push('max-tokens-new-turn', 'recovery-tool-result');
  const beforeStop = requests;
  response = 'waiting';
  const ready = new Promise(resolve => { waitingReady = resolve; });
  const stopped = send(); await bound(ready);
  assert.equal(current.inbox.nextStep.length, 0, 'assist never leaves injected messages');
  current.cancel({ kind: 'user' }); await stopped;
  assert.equal(requests - beforeStop, 1, 'user stop suppresses followup');
  assert.equal(current.inbox.nextStep.length, 0); assert.equal(current.inbox.nextTurn.length, 0);
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).latestEvent.action, 'correction-revoked');
  assert.equal(ctx.flashStabilizer.sessionStatus(current.id).live.risk, 'confirmed');
  checks.push('assist-user-stop-evidence');
  checks.push('assist-user-stop', 'no-injected-residue');
  await pluginFiber.dispose();
  pluginFiber = ctx.plugin(stabilizer, { ...hostHint, mode: 'guard' }); await pluginFiber;
  current = await ctx.agentLoop.create(sessions.SessionId(`guard-probe-${version}`), { provider: 'mock', model: 'deepseek-flash' });
  response = 'guard';
  const beforeGuard = requests, beforeGuardTools = toolBodies, beforeGuardCorrections = correctionsSeen;
  await send();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests - beforeGuard, 1, 'guard must not submit a recovery request');
  assert.equal(toolBodies, beforeGuardTools, 'guard never replays tools');
  assert.equal(correctionsSeen, beforeGuardCorrections, 'guard adds no correction prompt');
  assert.equal(guardClosed, true, 'cancel closes the upstream iterator');
  assert.ok(guardConsumed < 3000, 'stop before consuming the full loop');
  assert.ok(ctx.flashStabilizer.status().events.some(e => e.action === 'stop-confirmed'), 'durable host stop confirmed');
  assert.equal(current.inbox.nextStep.length, 0); assert.equal(current.inbox.nextTurn.length, 0);
  checks.push('guard-cancel', 'guard-settlement', 'guard-no-retry', 'guard-no-prompt');
  await ctx.flashStabilizer.setMode('observe');
  assert.equal(ctx.flashStabilizer.status().mode, 'observe');
  await ctx.flashStabilizer.setMode('guard');
  assert.equal(ctx.flashStabilizer.status().mode, 'guard');
  checks.push('runtime-mode-switch');
  for (const scenario of ['checklist', 'named-checklist', 'path-checklist', 'dense-checklist', 'dense-named-checklist', 'fenced-loop', 'inline-fence-loop', 'body-loop', 'single-letter', 'single-body', 'tool-then-single', 'fixed-number-phrase', 'queued-steering', 'queued-followup']) {
    response = scenario; queuedStep = 0;
    current = await ctx.agentLoop.create(sessions.SessionId(`${scenario}-${version}`), { provider: 'mock', model: 'deepseek-flash' });
    const before = requests;
    const ready = new Promise(resolve => { reviewReady = resolve; }); reviewResume = Promise.withResolvers();
    const done = send();
    if (scenario.startsWith('queued-')) {
      await bound(ready);
      const message = llm.createUserMessage({ content: [{ type: 'text', text: 'Handle queued user input.' }], source: { kind: 'user' } });
      if (scenario === 'queued-steering') current.steer(message); else current.followup(message);
      reviewResume.resolve();
    }
    await done; await new Promise(resolve => setImmediate(resolve));
    const status = ctx.flashStabilizer.sessionStatus(current.id);
    if (scenario.includes('checklist')) {
      const uncertainty = ['checklist', 'dense-checklist'].includes(scenario) ? 'changing-numbered-units' : 'changing-units';
      assert.ok(status.events.some(event => event.uncertainty === uncertainty && event.action === 'notify-only'));
      assert.equal(status.confirmed, 0); assert.equal(status.cancelRequested, 0);
      assert.equal(status.recoverySubmitted, 0); assert.equal(requests - before, 1);
      assert.equal(status.live.reasoningChars, scenarioChars, 'entire changing checklist completed');
    } else if (['single-letter', 'tool-then-single', 'fenced-loop', 'inline-fence-loop', 'fixed-number-phrase'].includes(scenario)) {
      assert.equal(status.confirmed, 1); assert.equal(status.cancelRequested, 1);
      assert.ok(status.events.some(event => event.action === 'stop-confirmed'));
      assert.equal(requests - before, scenario === 'tool-then-single' ? 2 : 1);
      assert.equal(status.recoverySubmitted, 0);
      assert.ok(status.live.reasoningChars < (scenario.includes('fence') || scenario === 'fixed-number-phrase' ? 2000 : 1200), 'stop occurs before consuming the full loop');
      if (scenario === 'tool-then-single') assert.equal(status.toolResults, 1, 'prior tool progress does not disable protection');
    } else if (scenario === 'single-body') {
      assert.equal(status.confirmed, 0); assert.equal(status.cancelRequested, 0);
      assert.equal(status.live.textChars, 34466);
    } else if (scenario === 'body-loop') {
      assert.deepEqual(status.events.filter(event => event.confirmed).map(event => event.contentType).sort(), ['reasoning', 'text']);
      assert.ok(status.events.some(event => event.action === 'stop-confirmed'));
      assert.ok(status.events.filter(event => event.kind === 'stream-repeat' && event.contentType === 'text').every(event => event.action === 'observe-only'));
    } else {
      assert.equal(status.cancelRequested, 0);
      assert.ok(status.events.some(event => event.action === 'user-input-takes-priority'));
      assert.equal(requests - before, 2, 'host consumes queued input exactly once');
      assert.equal(current.inbox.nextStep.length, 0); assert.equal(current.inbox.nextTurn.length, 0);
    }
    assert.ok(status.events.filter(event => event.kind === 'stream-repeat' && !event.confirmed && !event.uncertainty).every(event => event.action === 'observe-only'));
    checks.push(`guard-${scenario}`);
  }
  await pluginFiber.dispose();
  console.log('PROBE_RESULT ' + JSON.stringify({ version, status: 'passed', checks, requests, provider: 'deterministic-mock', node: process.version, packaged: !!process.argv[4] }));
} finally { await ctx.fiber.dispose(); }
