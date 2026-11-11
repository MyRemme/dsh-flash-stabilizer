// Re-sample real pre-failure DSH messages through the configured Pi transport.
// Nothing from the current workspace, AGENTS.md or Pi AgentSession is loaded.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const piRoot = join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const userPi = join(process.env.USERPROFILE, '.pi/agent');
process.env.PI_OFFLINE = '1'; process.env.PI_TELEMETRY = '0';
const { ModelRuntime } = await import(pathToFileURL(join(piRoot, 'dist/core/model-runtime.js')).href);
const directory = join(root, '.compat-cache/dsh-replay', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const runtime = await ModelRuntime.create({ modelsPath: join(userPi, 'models.json'), authPath: join(userPi, 'auth.json'),
  modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
const settings = JSON.parse(await readFile(join(userPi, 'settings.json'), 'utf8'));
const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
if (!model || !/deepseek.*flash/i.test(model.id)) throw Error('Configured Flash model missing');
const secret = (await runtime.getAuth(model))?.auth?.apiKey;
if (!secret) throw Error('Configured credential missing');
const redact = text => String(text).replaceAll(secret, '[REDACTED]');
const hash = text => createHash('sha256').update(text).digest('hex');
const available = JSON.parse(await readFile(join(root, '.compat-cache/dsh-evidence/cases.json'), 'utf8'));
const indices = process.env.DSH_REPLAY_CASES ? process.env.DSH_REPLAY_CASES.split(',').map(Number)
  : available.filter(c => c.foldError === null && c.config?.reasoningEffort === 'high'
    && !c.blockCounts.image).slice(0, 8).map(c => c.case);
if (!indices.length || indices.length > 10 || indices.some(i => !available.some(c => c.case === i))) throw Error('Invalid bounded case plan');
const maxTokens = 32768, timeoutMs = 240000;
const results = [];
const manifest = { startedAt: new Date().toISOString(), model: model.id, cases: indices,
  method: 'Pi ModelRuntime with onPayload returning explicit DSH-derived OpenAI body; HTTP body equality asserted',
  addedMessages: 0, contextDiscovery: false, toolExecution: false, maxRetries: 0, maxTokens, timeoutMs,
  samplingOverride: false, sourceFailureExcluded: true,
  limitations: ['Reconstructed canonical DSH input, not a captured original HTTP body',
    'Original DSH system/developer/tool text is retained; no new instructions added',
    'Route uses current user-configured Pi model and has a bounded output cap',
    'History reasoning is explicitly serialized as reasoning_content; original adapter behavior is not known'],
  runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))) };
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ directory, requests: indices.length, maxTokens }));
for (const index of indices) {
  const id = `case-${String(index).padStart(2, '0')}`;
  const sourceDir = join(root, '.compat-cache/dsh-evidence', id);
  const summary = JSON.parse(await readFile(join(sourceDir, 'summary.json'), 'utf8'));
  assert.equal(summary.foldError, null);
  const request = JSON.parse(await readFile(join(sourceDir, 'request.json'), 'utf8'));
  const priorLoops = [];
  for (const [n, m] of request.messages.entries()) {
    const monitor = new StreamMonitor(defaults, e => { if (e.confirmed) priorLoops.push(n); });
    m.content.forEach((b, i) => { if (b.type === 'reasoning') monitor.push({ type: 'block-end', index: i, block: b }); });
  }
  assert.equal(priorLoops.length, 0, 'Failed reasoning must not be seeded');
  assert.equal(summary.blockCounts.image ?? 0, 0, 'Image materialization is not implemented');
  const messages = request.messages.map(m => {
    const b = m.content;
    const text = b.filter(x => x.type === 'text').map(x => x.text).join('');
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: text };
    const out = { role: m.role, content: text };
    if (m.role === 'assistant') {
      const reasoning = b.filter(x => x.type === 'reasoning').map(x => x.text).join('');
      if (reasoning) out.reasoning_content = reasoning;
      const calls = b.filter(x => x.type === 'tool-call');
      if (calls.length) out.tool_calls = calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
    }
    assert.ok(b.every(x => ['text', 'reasoning', 'tool-call'].includes(x.type)), 'Unsupported canonical block');
    return out;
  });
  const tools = (request.header.tools ?? []).map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const effort = request.header.config.reasoningEffort ?? 'high';
  const body = { model: model.id, messages, tools, stream: true, stream_options: { include_usage: true },
    reasoning_effort: effort, max_tokens: maxTokens };
  const encoded = JSON.stringify(body), controller = new AbortController();
  const timer = setTimeout(() => controller.abort('test-timeout'), timeoutMs);
  const raw = [], events = [], reads = [], evidence = [];
  const monitor = new StreamMonitor(defaults, e => evidence.push(e));
  let wireCalls = 0, payloadCalls = 0, wireVerified = false, error, message;
  const start = Date.now();
  try {
    const stream = runtime.streamSimple(model, { messages: [{ role: 'user', content: 'transport placeholder', timestamp: 1 }] }, {
      reasoning: effort, maxTokens, maxRetries: 0, signal: controller.signal, timeoutMs,
      // This replaces, rather than appends to, the SDK-generated placeholder.
      onPayload: () => { assert.equal(++payloadCalls, 1); return body; },
      fetch: async (input, init) => {
        assert.equal(++wireCalls, 1);
        const wire = typeof init?.body === 'string' ? init.body : await input.clone().text();
        assert.deepEqual(JSON.parse(wire), body, 'Pi changed explicit request body');
        assert.ok(!wire.includes(secret));
        wireVerified = true;
        await writeFile(join(directory, `${id}.request.json`), wire);
        const response = await fetch(input, init), record = { status: response.status, body: '' };
        raw.push(record);
        reads.push((async () => {
          const reader = response.clone().body?.getReader(), decoder = new TextDecoder();
          try { if (reader) while (true) { const { value, done } = await reader.read(); if (done) break; record.body += decoder.decode(value, { stream: true }); } }
          catch (e) { record.readError = redact(e.message); }
          finally { record.body += decoder.decode(); reader?.releaseLock(); }
        })());
        return response;
      },
    });
    for await (const e of stream) {
      if (e.type === 'thinking_delta') monitor.push({ type: 'reasoning-delta', index: e.contentIndex, text: e.delta });
      const { partial, ...small } = e; events.push(small);
    }
    message = await stream.result();
  } catch (e) { error = redact(e.message); }
  await Promise.allSettled(reads); clearTimeout(timer);
  const records = raw.flatMap(r => r.body.split(/\r?\n/).flatMap(line => {
    try { return line.startsWith('data:') ? [JSON.parse(line.slice(5).trim())] : []; } catch { return []; }
  }));
  const reasoning = records.flatMap(r => (r.choices ?? []).map(c => c.delta?.reasoning_content ?? c.delta?.reasoning ?? '')).join('');
  const text = records.flatMap(r => (r.choices ?? []).map(c => c.delta?.content ?? '')).join('');
  const toolDeltas = records.flatMap(r => (r.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []));
  // Audit the raw response independently of SDK content-index conventions.
  const rawEvidence = [], rawMonitor = new StreamMonitor(defaults, e => rawEvidence.push(e));
  rawMonitor.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } });
  const result = { case: index, sourceRequestSha256: summary.requestSha256,
    bodySha256: hash(encoded), wireCalls, payloadCalls, isolationPassed: wireVerified && wireCalls === 1 && payloadCalls === 1,
    effort, durationMs: Date.now() - start, reasoningChars: reasoning.length, finalChars: text.length,
    toolDeltas: toolDeltas.length, confirmed: rawEvidence.some(e => e.confirmed),
    detectedAtChars: rawEvidence.find(e => e.confirmed)?.chars ?? null,
    evidence: rawEvidence, error: error ?? message?.errorMessage ?? null,
    finish: records.flatMap(r => (r.choices ?? []).map(c => c.finish_reason).filter(Boolean)),
    usage: records.map(r => r.usage).filter(Boolean).at(-1) ?? null,
    timedOut: controller.signal.aborted, stopReason: message?.stopReason ?? null,
    historyRoles: summary.roles, declaredTools: tools.length, toolExecutions: 0,
  };
  await writeFile(join(directory, `${id}.raw.json`), redact(JSON.stringify(raw)));
  await writeFile(join(directory, `${id}.message.json`), redact(JSON.stringify(message ?? null)));
  await writeFile(join(directory, `${id}.events.jsonl`), redact(events.map(e => JSON.stringify(e)).join('\n')));
  results.push(result);
  await writeFile(join(directory, 'results.json'), JSON.stringify({ ...manifest, results }, null, 2));
  console.log(JSON.stringify({ ...result, evidence: undefined, historyRoles: undefined, usage: result.usage,
    seconds: +(result.durationMs / 1000).toFixed(1) }));
  if (!result.isolationPassed) throw Error('Stopped after request isolation failure');
}
