// Offline host test: original failed stream, actual Cordis/AgentLoop cancellation.
// A copied test-only matrix enables the dormant path; distributed gates stay shut.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
import * as llm from '@deepseek-ai/dsh-llm';
import * as sessions from '@deepseek-ai/dsh-session';
import projections from '@deepseek-ai/dsh-session-projection';
import prompt from '@deepseek-ai/dsh-system-prompt';
import tools from '@deepseek-ai/dsh-tools';
import agents from '@deepseek-ai/dsh-agent';
import loop from '@deepseek-ai/dsh-agent-loop';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.compat-cache/dsh-evidence');
const cases = JSON.parse(await readFile(join(output, 'cases.json'), 'utf8'));
const c = cases.find(c => c.case === 3);
const failure = JSON.parse(await readFile(join(c.directory, 'failure.json'), 'utf8'));
const stream = llm.expandAssistantStream(failure.data.stream);
const testRoot = join(output, 'recovery-probe');
await mkdir(join(testRoot, 'compatibility'), { recursive: true });
await cp(join(root, 'dist'), join(testRoot, 'dist'), { recursive: true });
const matrix = JSON.parse(await readFile(join(root, 'compatibility/releases.json'), 'utf8'));
matrix.releases.find(r => r.version === '0.2.2-rc.1').interventionVerified = true;
await writeFile(join(testRoot, 'compatibility/releases.json'), JSON.stringify(matrix));
await writeFile(join(testRoot, 'package.json'), JSON.stringify({ type: 'module' }));
const plugin = await import(pathToFileURL(join(testRoot, 'dist/index.js')).href);
const ctx = new Context(), require = createRequire(import.meta.url);
let handle, current, requests = 0, consumed = 0, sawAbort = false, closed = false;
const turns = [], responses = [];
try {
  for (const service of [llm.default, sessions.default, projections, prompt, tools, agents, loop])
    await ctx.plugin(service, service === prompt ? { personaPrefix: '', personaSuffix: '' } : service === loop ? { agents: [] } : {});
  const executor = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-executor-native')).href);
  await ctx.plugin(executor);
  class Adapter extends llm.LlmAdapter {
    async *stream(options) {
      requests++;
      const correction = options.messages.some(m => m.content?.some(b => b.type === 'text' && b.text.includes('检测到当前步骤出现重复推理。')));
      responses.push({ request: requests, correction });
      assert.equal(options.model, 'fixture:deepseek-v4.1-flash');
      if (requests === 1) {
        try {
          for (const timed of stream) {
            if (options.signal.aborted) { sawAbort = true; return; }
            consumed++;
            yield timed.chunk;
          }
        } finally { closed = true; }
      } else {
        assert.equal(requests, 2, 'Exactly one recovery request');
        assert.equal(correction, true);
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Offline recovery response.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['offline'], new Adapter());
  ctx.on('session/event', (_session, event) => { if (event.type === 'turn/end') turns.push(event.data); });
  const pluginFiber = ctx.plugin(plugin, { mode: 'auto' });
  await pluginFiber;
  assert.ok(ctx.get('flashStabilizer'), `Plugin inactive: ${pluginFiber.status}; services ${!!ctx.get('agents')}/${!!ctx.get('llm')}/${!!ctx.get('tools')}`);
  assert.equal(ctx.flashStabilizer.status().mode, 'auto');
  current = await ctx.agentLoop.create(sessions.SessionId('offline-real-stream'), { provider: 'offline', model: 'fixture:deepseek-v4.1-flash' });
  current.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Offline lifecycle probe.' }], source: { kind: 'user' } }));
  let timer;
  await Promise.race([current.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Host probe timed out')), 20000); })]).finally(() => clearTimeout(timer));
  // The driver's idle notification queues recovery in a microtask.
  await new Promise(resolve => setImmediate(resolve));
  await current.whenIdle();
  assert.equal(requests, 2);
  assert.equal(closed, true);
  assert.ok(consumed < stream.length);
  assert.ok(turns.some(t => t.reason?.kind === 'aborted' && t.reason.reason?.kind === 'hook'));
  assert.ok(turns.some(t => t.reason?.kind === 'completed'));
  const result = { passed: true, host: '0.2.2-rc.1', testOnlyGate: true,
    realProvider: false, liveModelRequests: 0, originalFailureSha256: c.source.sha256,
    originalChunks: stream.length, consumedChunks: consumed, sawAbort, iteratorClosed: closed,
    requests, responses, turns, status: ctx.flashStabilizer.status(),
    conclusion: 'Actual host cancels recorded stream and delivers one bounded followup; model recovery quality not tested' };
  await writeFile(join(output, 'recovery-host-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await ctx.fiber.dispose(); }
