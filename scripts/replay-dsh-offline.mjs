import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandAssistantStream, assembleAssistantStream } from '@deepseek-ai/dsh-llm';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(root, '.compat-cache/dsh-evidence');
const cases = JSON.parse(await readFile(join(evidence, 'cases.json'), 'utf8'));
const results = [];
for (const c of cases) {
  const failed = JSON.parse(await readFile(join(c.directory, 'failure.json'), 'utf8'));
  const chunks = expandAssistantStream(failed.data.stream);
  let currentTime, currentChunk = 0, confirmed;
  const monitor = new StreamMonitor(defaults, e => {
    if (e.confirmed && !confirmed) confirmed = { ...e, chunk: currentChunk, time: currentTime };
  });
  for (const timed of chunks) {
    currentTime = timed.time; currentChunk++;
    monitor.push(timed.chunk);
  }
  const reason = chunks.filter(t => t.chunk.type === 'reasoning-delta').map(t => t.chunk.text).join('');
  const content = failed.data.message?.content ?? assembleAssistantStream(failed.data.stream).interruptedBlocks();
  const original = content.filter(b => b.type === 'reasoning').map(b => b.text).join('');
  assert.equal(reason, original, 'Reconstructed deltas must match stored reasoning');
  const result = { case: c.case, sourceSha256: c.source.sha256, confirmed: !!confirmed,
    reasoningChars: reason.length, finalChars: c.source.finalChars, toolCalls: c.source.toolCalls,
    originalChunks: chunks.length, detectedAtChars: confirmed?.chars ?? null,
    detectedAtChunk: confirmed?.chunk ?? null,
    historicalDetectionMs: confirmed ? confirmed.time - chunks[0].time : null,
    historicalDurationMs: chunks.at(-1).time - chunks[0].time,
    sourceEffort: c.config?.reasoningEffort ?? 'not-recorded',
    sourceOutputTokens: failed.data.usage?.outputTokens ?? null,
    originalDeltaBoundariesPreserved: true, addedModelRequests: 0,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(join(evidence, 'offline-results.json'), JSON.stringify({ createdAt: new Date().toISOString(),
  method: 'Offline original timed stream, not a new model generation or token-saving measurement', results }, null, 2));
