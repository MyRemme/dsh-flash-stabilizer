// EXPLORATORY AGENT TEST ONLY: uses a neutral system prompt and @file wrapping.
// This is not a native model baseline. Use test-pi-native.mjs for that purpose.
// Uses an existing Pi connection. Credentials stay in memory and child env only.
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const userPi = process.env.PI_LIVE_CONFIG_DIR ?? join(process.env.USERPROFILE, '.pi/agent');
const cli = process.env.PI_LIVE_CLI ?? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const settings = JSON.parse(await readFile(join(userPi, 'settings.json'), 'utf8'));
const catalog = JSON.parse(await readFile(join(userPi, 'models.json'), 'utf8'));
const providerName = settings.defaultProvider;
const provider = catalog.providers[providerName];
const selected = provider?.models?.find(m => m.id === settings.defaultModel);
if (!selected || !/deepseek.*flash/i.test(selected.id)) throw new Error('Select the configured DeepSeek Flash model in Pi first');
const phase = process.argv[2] ?? 'smoke';
if (!['smoke', 'baseline', 'agentic'].includes(phase)) throw new Error('Use smoke, baseline or agentic');
const label = new Date().toISOString().replace(/[:.]/g, '-');
const directory = process.env.PI_LIVE_RESUME_DIR ? resolve(process.env.PI_LIVE_RESUME_DIR) : join(root, '.compat-cache/pi-live', `${label}-${phase}`);
if (!directory.toLowerCase().startsWith(join(root, '.compat-cache/pi-live').toLowerCase())) throw new Error('Resume path must be inside the test workspace');
const config = join(directory, 'agent');
const cwd = join(directory, 'work');
await mkdir(config, { recursive: true }); await mkdir(cwd, { recursive: true });
const secret = typeof provider.apiKey === 'string' ? provider.apiKey : '';
if (!secret || secret.startsWith('!')) throw new Error('This test runner requires the existing model API key or environment reference');
const resolvedKey = secret.startsWith('$') ? process.env[secret.replace(/^\$\{?/, '').replace(/\}$/, '')] : secret;
if (!resolvedKey) throw new Error('Configured API key environment variable is missing');
const maxTokens = Number(process.env.PI_LIVE_MAX_TOKENS ?? (phase === 'smoke' ? 1024 : 8192));
if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 32768) throw new Error('Require 1024..32768 max output tokens');
await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { [providerName]: {
  ...provider, apiKey: '$PI_LIVE_EXISTING_KEY', models: [{ ...selected, maxTokens }],
} } }, null, 2));
await writeFile(join(config, 'settings.json'), JSON.stringify({
  defaultProvider: providerName, defaultModel: selected.id, defaultThinkingLevel: 'high',
  compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 120000 } },
  cacheWarming: { enabled: false }, enableInstallTelemetry: false, enableAnalytics: false,
}));
await writeFile(join(config, 'auth.json'), '{}');

const sources = {
  checksum: 'https://github.com/deepseek-ai/DeepSeek-V3/issues/1008',
  native: 'https://github.com/deepseek-ai/deepseek-recipe/issues/24',
  parser: 'https://github.com/vllm-project/vllm/issues/62935',
  silent: 'https://github.com/deepseek-ai/deepseek-harness/discussions/11943',
};
const agentic = phase === 'agentic', perRunRequests = agentic ? 8 : 1;
const checksum = '08a201A7F62C1E6D6AE7D6F6E3B01E4D5F4A5A5A5A5A5A5A5A5A5A';
function context(size) {
  const lines = [];
  for (let i = 0; lines.join('\n').length < size; i++) lines.push(`Audit ${i}: file component_${i % 37}.py; migration version ${100 + i}; checked rows ${i * 7 + 3}; no pending writes.`);
  lines.splice(Math.floor(lines.length / 2), 0, 'CANARY: storage migration 17 completed. UI work still pending. The required verification code is ORCHID-7319.');
  return lines.join('\n');
}
const cases = phase === 'smoke' ? [{ id: 'smoke', effort: 'high', prompt: 'Compute 17 * 19. Return only the integer.', check: 'integer', expected: 323, source: null, provenance: 'synthetic-control' }] : agentic ? [
  {id:'tool-ui-after-migration',fixture:'audit',source:sources.silent,provenance:'synthetic-multistep-tool-analogue-original-session-not-public',check:'tool',prompt:context(8000)+'\nImplement read-only audit selection first; automatic switching will be added later. Migration 17 is already complete, do not redo it. Read store.js and view.js using bench_read. Replace view.js using bench_patch with a pure JS function renderAudit(rows, selectedId). It must return {options,selectedId,readOnly:true}; options must be rows mapped to {value:row.id,label:row.label}. Keep selectedId only if some row has row.id === selectedId; otherwise use the first row id or null for empty rows. Never mutate rows. Run bench_test and fix failures, then give a brief final result. No other actions are needed.'},
  {id:'tool-parser-long',fixture:'parser',source:sources.parser,provenance:'synthetic-multistep-special-markup-analogue-private-original-history-unavailable',check:'tool',prompt:context(96000)+'\nRead parser.js with bench_read and fix it with bench_patch. splitThinking(s) must split at the first literal </think> outside single-backtick or triple-backtick spans and return {thinking,answer}, excluding the delimiter. Without an unquoted delimiter return {thinking:s,answer:""}. Treat <｜end_of_query｜> and <tool_call> as ordinary data. Handle the specified single/triple spans only; do not implement general Markdown. Run bench_test and fix failures. Give a brief final report.'},
] : [
  { id: 'algorithm', prompt: 'Write only a JavaScript function mergeIntervals(intervals). Input contains finite numeric half-open [start,end) pairs with start <= end. Drop empty intervals. Sort by start then end. Merge only overlapping intervals, never merely touching intervals. Do not mutate input. No imports or I/O. Return the merged array.', check: 'code', source: null, provenance: 'synthetic-quality-control' },
  { id: 'checksum-a5', prompt: `Create a Dockerfile that builds NGINX 1.24.0 from source and verifies SHA512 using: ${checksum}`, check: 'checksum', source: sources.checksum, provenance: 'adapted-public-prompt-from-older-model' },
  { id: 'parser-markup', prompt: 'Implement a pure JavaScript function splitThinking(s) for a streaming-parser regression. The literal delimiter </think> ends a thinking section only when outside single-backtick or triple-backtick spans. Treat <｜end_of_query｜> and <tool_call> as ordinary input data. Return {thinking,answer}; use the first unquoted delimiter, excluding it. Without a delimiter return {thinking:s,answer:""}. Return only the function, no imports or I/O.', check: 'parser', source: sources.parser, provenance: 'synthetic-analogue-original-histories-not-public' },
  { id: 'context-8k', prompt: context(8000) + '\nTask: Data migration is already complete. List the remaining UI work in one sentence and return the required verification code. Do not repeat completed migration work.', check: 'canary', source: sources.silent, provenance: 'synthetic-analogue-not-original-447-turn-session' },
  { id: 'context-96k', prompt: context(96000) + '\nTask: Data migration is already complete. List the remaining UI work in one sentence and return the required verification code. Do not repeat completed migration work.', check: 'canary', source: sources.native, provenance: 'synthetic-long-context-analogue-not-original-74657-token-history' },
];
const runs = phase === 'smoke' ? cases : [];
const efforts = (process.env.PI_LIVE_EFFORTS ?? 'high,max').split(',');
const repeats = Number(process.env.PI_LIVE_REPEATS ?? (agentic ? 1 : 2));
const filter = process.env.PI_LIVE_CASES?.split(',');
if (phase !== 'smoke') for (const effort of efforts) for (let repeat = 1; repeat <= repeats; repeat++) for (const c of cases) if (!filter || filter.includes(c.id)) runs.push({ ...c, effort, repeat });
if (runs.length > 24 || !efforts.every(x => ['high', 'max'].includes(x)) || !Number.isSafeInteger(repeats) || repeats < 1) throw new Error('Invalid or excessive test batch');
const manifest = {
  nativeModelBaseline: false, addedInput: ['neutral system prompt', 'Pi @file input wrapping'],
  startedAt: new Date().toISOString(), phase, piVersion: '1.5.0', provider: providerName, model: selected.id,
  connection: 'Existing user-configured Pi route, official upstream as confirmed by user; not independently audited',
  maxTokens, requestBudget: runs.length, maxRequestsPerRun: perRunRequests, timeoutMsPerRun: 120000, tools: agentic ? 'fixture-only' : false, extensions: agentic ? 'explicit-fixture-only' : false,
  samplingOverride: false, configurationMutation: 'temporary test config only',
  limitations: ['Small exploratory sample, not an incidence estimate', 'Public V4.1 reports lack original request histories; analogues do not reproduce their exact conditions', 'No access to server logits or token probabilities; cannot establish sampling-engine causality', 'No DSH plugin or intervention is loaded', 'High/max requests share the configured gateway, whose upstream translation is outside this test audit'],
  cases: cases.map(c => ({ id: c.id, source: c.source, provenance: c.provenance, inputChars: c.prompt.length })),
};
let prior;
if (process.env.PI_LIVE_RESUME_DIR) {
  prior = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
  if (prior.maxTokens !== maxTokens || prior.model !== selected.id || prior.requestBudget !== runs.length) throw new Error('Resume configuration differs');
  manifest.startedAt = prior.startedAt;
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(directory, 'cases.json'), JSON.stringify(cases, null, 2));

function codeOf(text) {
  const match = /^```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/im.exec(text);
  return (match?.[1] ?? text).trim().replace(/^export\s+/m, '');
}
async function validate(c, text, name) {
  if (c.check === 'integer') return { passed: Number(text.trim()) === c.expected };
  if (c.check === 'canary') return { passed: text.includes('ORCHID-7319') && /UI|界面|dropdown|select|下拉/i.test(text) };
  if (c.check === 'checksum') return { passed: null, checksumPreserved: text.includes(checksum), invalidHashAcknowledged: /invalid|not.*valid|not.*128|128.*hex|无效|不.*有效|长度|不是.*SHA/i.test(text), manualReviewRequired: true };
  if (!['code', 'parser'].includes(c.check)) return { passed: null };
  // Evaluate only in a separate Node process, with no inherited credentials,
  // no require/process inside the VM, a memory ceiling and per-script timeout.
  const sourceFile = join(directory, `${name}.code.txt`);
  await writeFile(sourceFile, codeOf(text));
  const worker = join(root, 'scripts/pi-live-code-check.mjs');
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', worker, c.check, sourceFile], { cwd, env: {}, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  } catch { return { passed: false, reason: 'Code compilation, timeout or test failure' }; }
}
function repetition(content) {
  const events = [], monitor = new StreamMonitor(defaults, e => events.push(e));
  for (let index = 0; index < content.length; index++) {
    const block = content[index];
    const text = block.type === 'thinking' ? block.thinking ?? '' : block.type === 'text' ? block.text ?? '' : '';
    monitor.push({ type: 'block-end', index, block: { type: block.type === 'thinking' ? 'reasoning' : 'text', text } });
  }
  const all = content.map(b => b.thinking ?? b.text ?? '').join('\n');
  let longestIdenticalRun = 0, longestA5Run = 0;
  for (const match of all.matchAll(/(.)\1{7,}/gu)) longestIdenticalRun = Math.max(longestIdenticalRun, [...match[0]].length);
  for (const match of all.matchAll(/(?:A5){4,}/gi)) longestA5Run = Math.max(longestA5Run, match[0].length / 2);
  return { confirmedByCurrentDetector: events.some(e => e.confirmed), maxDetectorScore: Math.max(0, ...events.map(e => e.score)), longestIdenticalRun, longestA5Run };
}
const results = prior?.results ?? [];
for (let index = 0; index < runs.length; index++) {
  const c = runs[index], name = `${String(index + 1).padStart(2, '0')}-${c.id}-${c.effort}-${c.repeat ?? 1}`;
  if (results.some(r => r.name === name)) continue;
  const auditPath = join(directory, `${name}.request.jsonl`), outputPath = join(directory, `${name}.events.jsonl`);
  const start = Date.now(); let raw = '', stderr = '', timedOut = false, firstOutputMs;
  await writeFile(join(directory, `${name}.prompt.txt`), c.prompt);
  // A loopback relay audits exact request bytes because Pi's bundled transport
  // does not use globalThis.fetch. It forwards the body without modification.
  let requestCalls = 0;
  const target = new URL(selected.baseUrl ?? provider.baseUrl);
  const relay = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !/\/(chat\/completions|messages|responses)\/?$/.test(req.url) || ++requestCalls > perRunRequests) { res.writeHead(429); res.end('Test request budget exhausted'); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('Input budget exceeded'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString());
      const messages = body.messages ?? body.input ?? [];
      await appendFile(auditPath, JSON.stringify({ time: new Date().toISOString(), endpoint: target.origin + req.url,
        model: body.model, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
        temperature: body.temperature ?? null, top_p: body.top_p ?? null, thinking: body.thinking ?? null,
        reasoning_effort: body.reasoning_effort ?? null, tools: body.tools?.length ?? 0,
        messageCount: messages.length, inputChars: JSON.stringify(messages).length,
        bodySha256: createHash('sha256').update(bytes).digest('hex') }) + '\n');
      const headers = { ...req.headers }; delete headers.host; delete headers.connection;
      const upstream = await fetch(target.origin + req.url, { method: 'POST', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(115000) });
      const outputHeaders = Object.fromEntries(upstream.headers);
      for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'connection']) delete outputHeaders[key];
      res.writeHead(upstream.status, outputHeaders);
      if (upstream.body) Readable.fromWeb(upstream.body).pipe(res); else res.end();
    } catch { if (!res.headersSent) res.writeHead(502); res.end('Bounded test transport failed'); }
  });
  await new Promise(done => relay.listen(0, '127.0.0.1', done));
  const relayBase = `http://127.0.0.1:${relay.address().port}${target.pathname}`;
  await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { [providerName]: {
    ...provider, baseUrl: relayBase, apiKey: '$PI_LIVE_EXISTING_KEY', models: [{ ...selected, baseUrl: relayBase, maxTokens }],
  } } }, null, 2));
  const toolLog = join(directory, `${name}.tools.jsonl`);
  const child = spawn(process.execPath, [cli,
    '--provider', providerName, '--model', selected.id, '--thinking', c.effort,
    '--no-session', ...(agentic ? ['--tools', 'bench_read,bench_patch,bench_test', '--extension', join(root, 'scripts/pi-live-fixture.mjs')] : ['--no-tools']),
    '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--offline',
    '--system-prompt', 'You are a careful assistant. Solve the user task accurately. Keep the final answer focused and complete. Do not claim actions you have not performed.',
    '--mode', 'json', '--print', '--', `@${join(directory, `${name}.prompt.txt`)}`], {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0',
      PI_LIVE_EXISTING_KEY: resolvedKey, PI_LIVE_AUDIT: auditPath, PI_LIVE_REQUEST_CAP: String(perRunRequests),
      PI_LIVE_FIXTURE: c.fixture ?? '', PI_LIVE_FIXTURE_DIR: cwd, PI_LIVE_TOOL_LOG: toolLog },
  });
  const redact = text => text.replaceAll(resolvedKey, '[REDACTED]');
  child.stdout.on('data', x => { raw += x; if (firstOutputMs === undefined && /thinking_delta|text_delta/.test(raw)) firstOutputMs = Date.now() - start; });
  child.stderr.on('data', x => { stderr = (stderr + x).slice(-10000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
  const code = await new Promise((done, reject) => { child.on('exit', done); child.on('error', reject); });
  clearTimeout(timer);
  relay.closeAllConnections(); await new Promise(done => relay.close(done));
  await writeFile(outputPath, redact(raw)); if (stderr) await writeFile(join(directory, `${name}.stderr.txt`), redact(stderr));
  const events = raw.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const assistants = events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').map(e => e.message);
  const message = assistants.at(-1);
  const content = message?.content ?? [];
  const allContent = assistants.flatMap(m => m.content ?? []);
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const thinking = content.filter(c => c.type === 'thinking').map(c => c.thinking ?? '').join('\n');
  let requests = []; try { requests = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch {}
  let toolEvents = []; try { toolEvents = (await readFile(toolLog, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch {}
  const usageMessages = assistants.filter(m => m.usage?.totalTokens > 0);
  const result = {
    name, case: c.id, effort: c.effort, repeat: c.repeat ?? 1, source: c.source, provenance: c.provenance,
    exitCode: code, timedOut, durationMs: Date.now() - start, firstOutputMs, requestCount: requests.length,
    stopReason: message?.stopReason ?? 'no-assistant-message', error: message?.errorMessage ? redact(message.errorMessage) : undefined,
    truncated: message?.stopReason === 'length' || /cut at its length|whole output spent on reasoning/i.test(message?.errorMessage ?? ''),
    usage: {input:usageMessages.reduce((s,m)=>s+m.usage.input,0),output:usageMessages.reduce((s,m)=>s+m.usage.output,0),reasoning:usageMessages.reduce((s,m)=>s+(m.usage.reasoning??0),0),cacheRead:usageMessages.reduce((s,m)=>s+m.usage.cacheRead,0),totalTokens:usageMessages.reduce((s,m)=>s+m.usage.totalTokens,0),missingForMessages:assistants.length-usageMessages.length},
    finalChars: text.length, thinkingChars: allContent.filter(c=>c.type==='thinking').reduce((s,c)=>s+(c.thinking?.length??0),0),
    emptyFinal: !text.trim(), toolCalls: allContent.filter(c => c.type === 'toolCall').length,
    repetition: repetition(allContent), validation: agentic ? {passed:toolEvents.filter(e=>e.tool==='test').at(-1)?.passed===true,toolEvents} : await validate(c, text, name), request: requests[0], requests,
  };
  await writeFile(join(directory, `${name}.answer.txt`), text);
  results.push(result);
  await writeFile(join(directory, 'results.json'), JSON.stringify({ ...manifest, completedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ run: index + 1, total: runs.length, case: c.id, effort: c.effort, stop: result.stopReason, outputTokens: result.usage?.output, finalChars: result.finalChars, thinkingChars: result.thinkingChars, repeat: result.repetition.confirmedByCurrentDetector, passed: result.validation.passed, seconds: +(result.durationMs / 1000).toFixed(1) }));
  if (!message || (result.error && !result.truncated) || requests.length < 1 || requests.length > perRunRequests || (!agentic && requests[0]?.tools !== 0)) {
    console.log('Stopping batch: request or isolation error. Inspect local diagnostics.'); break;
  }
}
console.log(JSON.stringify({ results: join(directory, 'results.json'), completed: results.length, planned: runs.length }));
