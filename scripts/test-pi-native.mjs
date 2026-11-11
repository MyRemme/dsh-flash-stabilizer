// Direct Pi ModelRuntime calls. No CLI, AgentSession, system prompt, tools or files
// are added to model input. Both the adapter payload and HTTP body are asserted.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const piRoot = process.env.PI_NATIVE_PACKAGE_DIR ?? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent');
const userPi = process.env.PI_NATIVE_CONFIG_DIR ?? join(process.env.USERPROFILE, '.pi/agent');
process.env.PI_OFFLINE = '1';
process.env.PI_TELEMETRY = '0';
const { ModelRuntime } = await import(pathToFileURL(join(piRoot, 'dist/core/model-runtime.js')).href);
const settings = JSON.parse(await readFile(join(userPi, 'settings.json'), 'utf8'));
const piVersion = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')).version;
const phase = process.argv[2] ?? 'smoke';
if (!['smoke', 'baseline'].includes(phase)) throw Error('Use smoke or baseline');
const cacheRoot = join(root, '.compat-cache/pi-native');
const directory = process.env.PI_NATIVE_RESUME_DIR ? resolve(process.env.PI_NATIVE_RESUME_DIR)
  : join(cacheRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${phase}`);
const rel = relative(cacheRoot, directory);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Results must be within .compat-cache/pi-native');
await mkdir(directory, { recursive: true });
// Only model/auth configuration is read; model cache writes are confined here.
const runtime = await ModelRuntime.create({
  modelsPath: join(userPi, 'models.json'), authPath: join(userPi, 'auth.json'),
  modelsStorePath: join(directory, 'models-store.json'),
  allowModelNetwork: false, refreshOnCreate: false,
});
const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
if (!model || !/deepseek.*flash/i.test(model.id)) throw Error('Configured Pi default must be DeepSeek Flash');
const auth = await runtime.getAuth(model);
const secret = auth?.auth?.apiKey;
if (typeof secret !== 'string' || !secret) throw Error('Existing configured model credential unavailable');
const redact = value => String(value).replaceAll(secret, '[REDACTED]');
const sha = value => createHash('sha256').update(value).digest('hex');
const maxTokens = Number(process.env.PI_NATIVE_MAX_TOKENS ?? (phase === 'smoke' ? 1024 : 16384));
const timeoutMs = 180000;
if (!Number.isSafeInteger(maxTokens) || maxTokens < 1024 || maxTokens > 32768) throw Error('Output cap must be 1024..32768');
const sources = {
  checksum: 'https://github.com/deepseek-ai/DeepSeek-V3/issues/1008',
  repeat: 'https://github.com/deepseek-ai/deepseek-recipe/issues/24',
  parser: 'https://github.com/vllm-project/vllm/issues/62935',
  silent: 'https://github.com/deepseek-ai/deepseek-harness/discussions/11943',
};
const checksum = '08a201A7F62C1E6D6AE7D6F6E3B01E4D5F4A5A5A5A5A5A5A5A5A5A';
function context(size) {
  const lines = []; let length = 0;
  for (let i = 0; length < size; i++) {
    const line = `Audit ${i}: file component_${i % 37}.py; migration version ${100 + i}; checked rows ${i * 7 + 3}; no pending writes.`;
    lines.push(line); length += line.length + 1;
  }
  lines.splice(Math.floor(lines.length / 2), 0, 'CANARY: storage migration 17 completed. UI work still pending. The required verification code is ORCHID-7319.');
  return lines.join('\n') + '\nTask: Data migration is already complete. List the remaining UI work in one sentence and return the required verification code. Do not repeat completed migration work.';
}
const cases = phase === 'smoke' ? [
  { id: 'smoke', prompt: 'Compute 17 * 19. Return only the integer.', check: 'integer', provenance: 'synthetic-control' },
] : [
  { id: 'algorithm', prompt: 'Write only a JavaScript function mergeIntervals(intervals). Input contains finite numeric half-open [start,end) pairs with start <= end. Drop empty intervals. Sort by start then end. Merge only overlapping intervals, never merely touching intervals. Do not mutate input. No imports or I/O. Return the merged array.', check: 'code', provenance: 'synthetic-quality-control' },
  { id: 'checksum-a5', prompt: `Create a Dockerfile that builds NGINX 1.24.0 from source and verifies SHA512 using: ${checksum}`, check: 'checksum', source: sources.checksum, provenance: 'adapted-public-prompt-from-older-model' },
  { id: 'parser-markup', prompt: 'Implement a pure JavaScript function splitThinking(s) for a streaming-parser regression. The literal delimiter </think> ends a thinking section only when outside single-backtick or triple-backtick spans. Treat <｜end_of_query｜> and <tool_call> as ordinary input data. Return {thinking,answer}; use the first unquoted delimiter, excluding it. Without a delimiter return {thinking:s,answer:""}. Return only the function, no imports or I/O.', check: 'parser', source: sources.parser, provenance: 'synthetic-analogue-original-histories-not-public' },
  { id: 'context-8k-chars', prompt: context(8000), check: 'canary', source: sources.silent, provenance: 'synthetic-single-message-not-original-447-turn-history' },
  { id: 'context-280k-chars', prompt: context(280000), check: 'canary', source: sources.repeat, provenance: 'synthetic-single-message-not-original-107-message-26-tool-history' },
];
const efforts = phase === 'smoke' ? ['high'] : (process.env.PI_NATIVE_EFFORTS ?? 'high,max').split(',');
const repeats = Number(process.env.PI_NATIVE_REPEATS ?? (phase === 'smoke' ? 1 : 2));
const filter = process.env.PI_NATIVE_CASES?.split(',');
const runs = [];
for (const effort of efforts) for (let repeat = 1; repeat <= repeats; repeat++) for (const c of cases)
  if (!filter || filter.includes(c.id)) runs.push({ ...c, effort, repeat });
if (!efforts.every(x => ['high', 'max'].includes(x)) || !Number.isSafeInteger(repeats) || repeats < 1 || runs.length < 1 || runs.length > 24) throw Error('Invalid or excessive batch');
const manifest = {
  startedAt: new Date().toISOString(), phase, piVersion, provider: model.provider, model: model.id,
  connection: 'Existing Pi connection; official as confirmed by user, upstream not re-investigated',
  entryPoint: 'Pi ModelRuntime.streamSimple, without CLI or AgentSession',
  systemPrompt: false, contextFiles: false, tools: false, extensions: false, skills: false,
  messagePolicy: 'Exactly one user message; text must equal the case prompt at adapter and HTTP boundaries',
  maxTokens, timeoutMs, maxRetries: 0, requestBudget: runs.length, maxRequestsPerRun: 1,
  samplingOverride: false, reasoning: efforts, userConfigMutation: false,
  rawCapture: 'Partial bytes preserved on stream abort; provider end events also observed',
  runnerSha256: sha(await readFile(fileURLToPath(import.meta.url), 'utf8')),
  detector: 'Offline observation only; no plugin or correction in the model request',
  limitations: [
    'Small exploratory sample; not a population incidence estimate',
    'Public V4.1 histories are unavailable, so these are synthetic analogues, not exact reproductions',
    'Input and raw response audited at the configured Pi endpoint; no claim about server-side prompt rewriting',
    'No logits or server sampling instrumentation, so no sampler root-cause attribution',
    'Single-turn, no-tool baseline does not reproduce long multi-turn tool trajectories',
    'Earlier CLI batches used a neutral system prompt and @file wrapping and are excluded',
  ],
  cases: cases.map(({ prompt, ...c }) => ({ ...c, inputChars: prompt.length, promptSha256: sha(prompt) })),
  runPlan: runs.map(c => ({ case: c.id, effort: c.effort, repeat: c.repeat, promptSha256: sha(c.prompt) })),
};
let results = [];
if (process.env.PI_NATIVE_RESUME_DIR) {
  const prior = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
  if (prior.model !== model.id || prior.maxTokens !== maxTokens || JSON.stringify(prior.runPlan) !== JSON.stringify(manifest.runPlan)) throw Error('Resume configuration differs');
  results = prior.results; manifest.startedAt = prior.startedAt;
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(join(directory, 'runner-source.mjs'), await readFile(fileURLToPath(import.meta.url), 'utf8'));
await writeFile(join(directory, 'cases.json'), JSON.stringify(cases, null, 2));
console.log(JSON.stringify({ directory, planned: runs.length, policy: manifest.messagePolicy }));

function assertPayload(payload, prompt) {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0].role !== 'user') throw Error('ISOLATION: expected exactly one user message');
  if (Object.keys(messages[0]).some(k => !['role', 'content'].includes(k))) throw Error('ISOLATION: unexpected message metadata');
  const content = messages[0].content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && content.length === 1 && content[0].type === 'text' ? content[0].text : undefined;
  if (text !== prompt) throw Error('ISOLATION: prompt is not verbatim');
  for (const key of ['system', 'systemPrompt', 'developer', 'instructions', 'prompt', 'input', 'tools', 'functions', 'tool_choice', 'function_call'])
    if (payload[key] !== undefined) throw Error(`ISOLATION: unexpected ${key}`);
  if (JSON.stringify(payload).includes(secret)) throw Error('ISOLATION: credential appeared in payload');
  return { messageCount: 1, roles: ['user'], verbatim: true, system: false, tools: false, inputChars: text.length, promptSha256: sha(text) };
}
function extractCode(text) {
  const match = /^```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/im.exec(text);
  return (match?.[1] ?? text).trim();
}
async function validate(c, answer, name) {
  if (c.check === 'integer') return { passed: answer.trim() === '323' };
  if (c.check === 'canary') return { passed: answer.includes('ORCHID-7319') && /UI|界面|dropdown|select|下拉/i.test(answer), manualReviewRequired: true };
  if (c.check === 'checksum') return { passed: null, manualReviewRequired: true, invalidHashAcknowledged: /invalid|not.*valid|128.*hex|not.*128|无效|长度/i.test(answer) };
  const code = extractCode(answer), sourcePath = join(directory, `${name}.code.txt`);
  await writeFile(sourcePath, code);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', join(root, 'scripts/pi-live-code-check.mjs'), c.check, sourcePath], {
      cwd: directory, env: {}, windowsHide: true, timeout: 5000, maxBuffer: 4096,
    });
    const functional = JSON.parse(stdout);
    return { ...functional, formatPassed: code === answer.trim() && /^(?:function\s|(?:const|let)\s)/.test(code), evaluatedExtractedCode: code !== answer.trim() };
  } catch { return { passed: false, reason: 'Code evaluation worker failed or timed out' }; }
}
function repetition(content) {
  const events = [], monitor = new StreamMonitor(defaults, event => events.push(event));
  content.forEach((block, index) => {
    if (['thinking', 'text'].includes(block.type)) monitor.push({ type: 'block-end', index, block: { type: block.type === 'thinking' ? 'reasoning' : 'text', text: block.thinking ?? block.text ?? '' } });
  });
  const all = content.map(b => b.thinking ?? b.text ?? '').join('\n');
  let longestIdenticalRun = 0, longestA5Run = 0;
  for (const m of all.matchAll(/(.)\1{7,}/gu)) longestIdenticalRun = Math.max(longestIdenticalRun, [...m[0]].length);
  for (const m of all.matchAll(/(?:A5){4,}/gi)) longestA5Run = Math.max(longestA5Run, m[0].length / 2);
  return { confirmedByCurrentDetector: events.some(e => e.confirmed), longestIdenticalRun, longestA5Run, events };
}
for (let i = 0; i < runs.length; i++) {
  const c = runs[i], name = `${String(i + 1).padStart(2, '0')}-${c.id}-${c.effort}-${c.repeat}`;
  if (results.some(r => r.name === name)) continue;
  const start = Date.now(), controller = new AbortController();
  let timedOut = false, message, failure, isolationFailure, firstOutputMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const audit = [], rawReads = [], events = [], rawResponses = [], providerEndEvents = [];
  let payloadCalls = 0, httpCalls = 0;
  const check = (payload, boundary) => {
    try {
      const evidence = assertPayload(payload, c.prompt);
      audit.push({ boundary, ...evidence, bodySha256: sha(JSON.stringify(payload)), keys: Object.keys(payload), model: payload.model,
        reasoning_effort: payload.reasoning_effort ?? null, thinking: payload.thinking ?? null,
        temperature: payload.temperature ?? null, top_p: payload.top_p ?? null,
        max_tokens: payload.max_tokens ?? null, max_completion_tokens: payload.max_completion_tokens ?? null });
    } catch (e) { isolationFailure = String(e.message); controller.abort(); throw e; }
  };
  try {
    const stream = runtime.streamSimple(model, { messages: [{ role: 'user', content: [{ type: 'text', text: c.prompt }], timestamp: Date.now() }] }, {
      reasoning: c.effort, maxTokens, maxRetries: 0, timeoutMs, signal: controller.signal,
      onProviderStreamEvent: data => {
        if (data?.error || data?.usage || data?.choices?.some(c => c.finish_reason)) providerEndEvents.push(data);
      },
      onPayload: async payload => {
        if (++payloadCalls > 1) throw Error('ISOLATION: repeated payload');
        check(payload, 'adapter');
        await writeFile(join(directory, `${name}.payload.json`), JSON.stringify(payload, null, 2));
        return undefined;
      },
      fetch: async (input, init) => {
        if (++httpCalls > 1) throw Error('ISOLATION: HTTP request budget exceeded');
        const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : null;
        if (!body) throw Error('ISOLATION: unable to inspect HTTP body');
        check(JSON.parse(body), 'http-wire');
        await writeFile(join(directory, `${name}.wire-request.json`), body);
        const response = await fetch(input, init);
        // Preserve bytes already seen even if the SDK aborts after an error.
        // Response.text() would reject and discard the entire partial capture.
        rawReads.push((async () => {
          const record = { status: response.status, body: '' };
          rawResponses.push(record);
          const reader = response.clone().body?.getReader(), decoder = new TextDecoder();
          try {
            if (reader) while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              record.body += decoder.decode(value, { stream: true });
            }
          } catch (e) { record.readError = redact(e.message); }
          finally { record.body += decoder.decode(); reader?.releaseLock(); }
        })());
        return response;
      },
    });
    for await (const e of stream) {
      if (firstOutputMs === undefined && ['thinking_delta', 'text_delta'].includes(e.type)) firstOutputMs = Date.now() - start;
      if (e.type === 'done') message = e.message;
      if (e.type === 'error') message = e.error;
      // Avoid recording the growing partial object for every token.
      const { partial, ...small } = e;
      events.push(small);
    }
    message = await stream.result();
  } catch (e) { failure = redact(e.message); }
  await Promise.allSettled(rawReads); clearTimeout(timer);
  const rawRecords = rawResponses.flatMap(r => (r.body ?? '').split(/\r?\n/).flatMap(line => {
    if (!line.startsWith('data:')) return [];
    try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
  }));
  const rawFinishes = rawRecords.flatMap(r => (r.choices ?? []).map(x => x.finish_reason).filter(Boolean));
  const rawUsage = rawRecords.map(r => r.usage).filter(Boolean).at(-1) ?? null;
  const content = message?.content ?? [], answer = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const thinking = content.filter(b => b.type === 'thinking').map(b => b.thinking).join('\n');
  const error = failure ?? (message?.errorMessage ? redact(message.errorMessage) : null);
  const result = {
    name, case: c.id, effort: c.effort, repeat: c.repeat, source: c.source ?? null, provenance: c.provenance,
    durationMs: Date.now() - start, firstOutputMs, timedOut, isolationFailure: isolationFailure ?? null,
    isolationPassed: !isolationFailure && payloadCalls === 1 && httpCalls === 1 && audit.length === 2,
    payloadCalls, httpCalls, audit, responseModel: message?.responseModel ?? null,
    httpStatus: rawResponses.map(r => r.status), rawReadErrors: rawResponses.map(r=>r.readError).filter(Boolean),
    providerEndEvents, stopReason: message?.stopReason ?? null, rawFinishes, error,
    truncated: rawFinishes.includes('length') || message?.stopReason === 'length' || /cut at its length|whole output spent on reasoning/i.test(error ?? ''),
    usage: message?.usage?.totalTokens > 0 ? message.usage : null, rawUsage,
    finalChars: answer.length, thinkingChars: thinking.length, emptyFinal: !answer.trim(),
    repetition: repetition(content), validation: await validate(c, answer, name),
  };
  await writeFile(join(directory, `${name}.answer.txt`), redact(answer));
  await writeFile(join(directory, `${name}.message.json`), redact(JSON.stringify(message ?? null, null, 2)));
  await writeFile(join(directory, `${name}.events.jsonl`), redact(events.map(e => JSON.stringify(e)).join('\n')));
  await writeFile(join(directory, `${name}.raw-response.json`), redact(JSON.stringify(rawResponses, null, 2)));
  results.push(result);
  await writeFile(join(directory, 'results.json'), redact(JSON.stringify({ ...manifest, completedAt: new Date().toISOString(), results }, null, 2)));
  console.log(JSON.stringify({ run: i + 1, total: runs.length, case: c.id, effort: c.effort, isolation: result.isolationPassed,
    stop: result.stopReason, rawFinishes, truncated: result.truncated, outputTokens: rawUsage?.completion_tokens ?? result.usage?.output ?? null,
    finalChars: result.finalChars, thinkingChars: result.thinkingChars, repeat: result.repetition.confirmedByCurrentDetector,
    passed: result.validation.passed, seconds: +(result.durationMs / 1000).toFixed(1) }));
  if (!result.isolationPassed || timedOut || !message || (error && !result.truncated)) {
    console.log('Stopped batch: isolation/transport error or timeout. Inspect local diagnostics.'); break;
  }
}
console.log(JSON.stringify({ results: join(directory, 'results.json'), completed: results.length, planned: runs.length }));
