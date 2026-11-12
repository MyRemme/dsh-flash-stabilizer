// Local evidence only: never sends model requests, executes tools or prints text/IDs.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm';
import { readSession } from './dsh-session-reader.mjs';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const [source, baselineDirectory, output] = process.argv.slice(2);
if (!source || !baselineDirectory || !output) throw Error('Usage: evaluate-single-letter <file-or-session-directory> <baseline-dist> <local-report>');
const { StreamMonitor: Baseline } = await import(pathToFileURL(resolve(baselineDirectory, 'monitor.js')).href);
const report = { method: 'offline-original-deltas', modelRequests: 0, files: 0, records: 0, assistantRecords: 0,
  beforeConfirmed: 0, afterConfirmed: 0, newConfirmations: 0, lostConfirmations: 0, singleLetterCandidates: 0, singleLetterDetected: 0, cases: [] };
async function* rows(file) {
  if (file.endsWith('.zstd')) { for await (const item of readSession(file)) yield item.record; return; }
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line);
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.name.endsWith('.jsonl.zstd')) result.push(file);
  }
  return result;
}
const paths = /\.jsonl(?:\.zstd)?$/.test(source) ? [source] : await files(source);
const scanOnlyCandidates = !/\.jsonl(?:\.zstd)?$/.test(source);
for (const file of paths) {
  report.files++;
  for await (const row of rows(file)) {
    report.records++;
    if (!['assistant/message', 'assistant/attempt'].includes(row.type) || !Array.isArray(row.data?.stream)) continue;
    report.assistantRecords++;
    const timed = expandAssistantStream(row.data.stream);
    const blocks = new Map();
    for (const { chunk } of timed) {
      if (chunk.type === 'reasoning-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning' && !blocks.has(chunk.index)) blocks.set(chunk.index, chunk.block.text ?? '');
    }
    const candidate = [...blocks.values()].some(text => {
      const counts = new Map();
      for (const unit of text.split(/[。！？!?;；\n\r/.()（）]/u).map(value => value.trim())) {
        if (/^\p{L}$/u.test(unit)) counts.set(unit, (counts.get(unit) ?? 0) + 1);
      }
      return [...counts.values()].some(count => count >= 80);
    });
    if (candidate) report.singleLetterCandidates++;
    if (scanOnlyCandidates && !candidate) continue;
    let before, after;
    const old = new Baseline(defaults, e => { if (e.confirmed && !before) before = e; });
    const current = new StreamMonitor(defaults, e => { if (e.confirmed && !after) after = e; });
    for (const { chunk } of timed) { old.push(chunk); current.push(chunk); }
    report.beforeConfirmed += Number(!!before); report.afterConfirmed += Number(!!after);
    report.newConfirmations += Number(!before && !!after); report.lostConfirmations += Number(!!before && !after);
    if (candidate && after) report.singleLetterDetected++;
    if (candidate || !before && after) report.cases.push({ ordinal: report.cases.length + 1, singleLetterCandidate: candidate,
      beforeConfirmed: !!before, afterConfirmed: !!after, detectedAtChars: after?.chars ?? null,
      reasoningChars: [...blocks.values()].reduce((sum, value) => sum + value.length, 0) });
  }
  if (report.files % 100 === 0) console.log(JSON.stringify({ filesScanned: report.files, singleLetterCandidates: report.singleLetterCandidates }));
}
assert.equal(report.lostConfirmations, 0, 'Existing confirmations must remain detected');
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, cases: undefined, candidateFiltered: scanOnlyCandidates }));
