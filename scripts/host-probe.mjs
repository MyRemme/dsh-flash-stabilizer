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
  let recoveryStep = 0, sawRecoveredToolResult = false, waitingReady;
  const turnReasons = [];
  ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') turnReasons.push(event.data.reason.kind); });
  const hostHint = process.argv[4] ? {} : { hostVersion: version };
  const raw = [];
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      requests++;
      if (options.messages.some(m => m.role === 'user' && m.content?.some(c => c.type === 'text' && c.text.includes('检测到当前步骤出现重复推理。')))) correctionsSeen++;
      assert.equal(options.model, 'deepseek-flash');
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
  ctx.llm.registerAdapter(['mock'], new Adapter());
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
  await pluginFiber.dispose();
  console.log('PROBE_RESULT ' + JSON.stringify({ version, status: 'passed', checks, requests, provider: 'deterministic-mock', node: process.version, packaged: !!process.argv[4] }));
} finally { await ctx.fiber.dispose(); }
