// Local-only verification. Never runs recorded tools or sends model requests.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { expandAssistantStream } from '@deepseek-ai/dsh-llm';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';

const [file, output] = process.argv.slice(2);
if (!file) throw new Error('Usage: node scripts/replay-session.mjs <local-session.jsonl> [report.json]');
const results = [];
let records = 0;
for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  records++;
  const row = JSON.parse(line);
  if (!['assistant/message', 'assistant/attempt'].includes(row.type)) continue;
  const timed = expandAssistantStream(row.data.stream ?? []);
  let confirmed, currentTime;
  const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);
  const monitor = new StreamMonitor(defaults, evidence => {
    if (evidence.confirmed && !confirmed) confirmed = { ...evidence, afterMs: milliseconds(currentTime) - milliseconds(timed[0].time) };
  });
  for (const item of timed) { currentTime = item.time; monitor.push(item.chunk); }
  const snapshot = monitor.snapshot();
  results.push({ turn: row.data.turn, step: row.data.step, confirmed: !!confirmed,
    reasoningChars: snapshot.reasoningChars, textChars: snapshot.textChars, checks: snapshot.checks, risk: snapshot.risk,
    ...(confirmed ? { method: confirmed.method, detectedAtChars: confirmed.chars, afterMs: confirmed.afterMs } : {}) });
}
const report = { method: 'offline-original-deltas', modelRequests: 0, records, assistantRecords: results.length,
  confirmed: results.filter(row => row.confirmed).length, results };
if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, results: undefined }));
