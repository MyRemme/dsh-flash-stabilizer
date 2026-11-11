// Read-only local evidence scan. The output directory is excluded from Git.
import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSession } from './dsh-session-reader.mjs';
import { StreamMonitor } from '../dist/monitor.js';
import { defaults } from '../dist/config.js';
import { periodicSuffix } from '../dist/detection.js';
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(process.env.USERPROFILE, '.dsh/sessions');
const output = join(root, '.compat-cache/dsh-evidence');
await mkdir(output, { recursive: true });
async function files(path) {
  const out = [];
  for (const e of await readdir(path, { withFileTypes: true })) {
    const full = join(path, e.name);
    if (e.isDirectory()) out.push(...await files(full));
    else if (/\.jsonl\.zstd$/.test(e.name)) out.push({ path: full, mtime: (await stat(full)).mtimeMs });
  }
  return out;
}
const paths = (await files(source)).sort((a, b) => b.mtime - a.mtime);
const candidates = [], longAttempts = [], errors = [], types = {};
let attempts = 0, completed = 0;
console.log(JSON.stringify({ files: paths.length, output }));
for (const { path } of paths) {
  let header, config = {}, context = {};
  try {
    for await (const { record: r, frameOffset } of readSession(path)) {
      types[r.type] = (types[r.type] ?? 0) + 1;
      if (r.type === 'session') header = r;
      if (r.type === 'request/header') config = r.data?.header?.config ?? config;
      if (r.type === 'request/context') context = r.data ?? context;
      if (!['assistant/message', 'assistant/attempt'].includes(r.type)) continue;
      attempts++;
      const d = r.data ?? {}, message = d.message ?? (Array.isArray(d.stream)
        ? { content: assembleAssistantStream(d.stream).interruptedBlocks() } : undefined);
      if (!Array.isArray(message?.content)) continue;
      const blocks = message.content, reasoning = blocks.filter(b => b.type === 'reasoning');
      const reasonChars = reasoning.reduce((n, b) => n + (b.text?.length ?? 0), 0);
      if (reasonChars < 1536) continue;
      const base = {
        path, session: header?.id, seq: r.seq, time: r.time, turn: d.turn, step: d.step,
        event: r.type, frameOffset, model: context.model ?? config.model,
        effort: config.reasoningEffort, maxTokens: config.maxTokens,
        reasoningChars: reasonChars,
        finalChars: blocks.filter(b => b.type === 'text').reduce((n, b) => n + (b.text?.length ?? 0), 0),
        toolCalls: blocks.filter(b => b.type === 'tool-call').length,
        usage: d.usage ?? null, hasStream: Array.isArray(d.stream),
      };
      longAttempts.push(base);
      for (let index = 0; index < blocks.length; index++) {
        const b = blocks[index];
        if (b.type !== 'reasoning' || (b.text?.length ?? 0) < 1536) continue;
        const text = b.text;
        const normalized = text.replace(/\s+/gu, '').slice(-8192);
        const periodic = periodicSuffix(normalized, 2, 256, 6);
        // Cheap gate before running the stream detector over large normal prose.
        if (periodic.coverage < 0.2) continue;
        const events = [], monitor = new StreamMonitor(defaults, e => events.push(e));
        monitor.push({ type: 'block-end', index, block: b });
        const confirmed = events.find(e => e.confirmed);
        const candidate = {
          ...base, block: index, chars: text.length,
          sha256: createHash('sha256').update(text).digest('hex'),
          normalizedPeriod: periodic, confirmed: !!confirmed,
          detectedAtChars: confirmed?.chars ?? null,
          lastEvidence: events.at(-1) ?? null,
          repeatedUnit: normalized.slice(-periodic.period),
        };
        candidates.push(candidate);
        console.log(JSON.stringify({ candidate: candidates.length, session: base.session, seq: r.seq,
          effort: base.effort, reasoningChars: reasonChars, finalChars: base.finalChars,
          toolCalls: base.toolCalls, confirmed: candidate.confirmed }));
      }
    }
  } catch (e) { errors.push({ path, error: e.message }); }
  completed++;
  if (completed % 50 === 0) console.log(JSON.stringify({ completed, attempts, candidates: candidates.length, errors: errors.length }));
}
const result = { createdAt: new Date().toISOString(), source, files: paths.length,
  attempts, longAttempts: longAttempts.length, candidates, errors, types };
await writeFile(join(output, 'scan.json'), JSON.stringify(result, null, 2));
await writeFile(join(output, 'long-attempts.json'), JSON.stringify(longAttempts, null, 2));
console.log(JSON.stringify({ finished: true, files: paths.length, attempts,
  longAttempts: longAttempts.length, candidates: candidates.length, errors: errors.length }));
