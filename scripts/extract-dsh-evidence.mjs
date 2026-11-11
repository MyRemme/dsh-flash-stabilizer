import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSession } from './dsh-session-reader.mjs';
import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { assembleAssistantStream } from '@deepseek-ai/dsh-llm';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.compat-cache/dsh-evidence');
const scan = JSON.parse(await readFile(join(output, 'scan.json'), 'utf8'));
const unique = [...new Map(scan.candidates.filter(c => c.confirmed && !c.toolCalls && !c.finalChars)
  .map(c => [c.sha256, c])).values()];
const results = [];
for (let index = 0; index < unique.length; index++) {
  const c = unique[index], prefix = [];
  let session, failed, nextEnd, header;
  for await (const { record: r } of readSession(c.path)) {
    if (r.type === 'session') { session = r; continue; }
    if (r.seq < c.seq) {
      prefix.push(r);
      if (r.type === 'request/header') header = r.data.header;
    } else if (r.seq === c.seq) failed = r;
    else if (r.type === 'turn/end') { nextEnd = r; break; }
  }
  const dir = join(output, `case-${String(index + 1).padStart(2, '0')}`);
  await mkdir(dir, { recursive: true });
  const failedContent = failed?.data.message?.content
    ?? assembleAssistantStream(failed.data.stream).interruptedBlocks();
  await writeFile(join(dir, 'failure.json'), JSON.stringify(failed));
  let foldError, messages, surface;
  try {
    surface = foldSurface(prefix);
    const bySeq = new Map(prefix.map(r => [r.seq, r]));
    messages = surface.nodes.map(seq => deriveEventMessage(bySeq.get(seq), surface.projectedMessages)).filter(Boolean);
  } catch (e) { foldError = e.message; }
  const modelMessages = messages ?? [];
  const blockCounts = {}, roles = {};
  for (const m of modelMessages) {
    roles[m.role] = (roles[m.role] ?? 0) + 1;
    for (const b of m.content ?? []) blockCounts[b.type] = (blockCounts[b.type] ?? 0) + 1;
  }
  const request = { header, messages: modelMessages };
  const encoded = JSON.stringify(request);
  const summary = {
    case: index + 1, directory: dir, source: c, sessionVersion: session?.version,
    config: header?.config, tools: header?.tools?.length ?? 0,
    foldError: foldError ?? null, surfaceReplacements: surface?.replacements.length ?? null,
    roles, blockCounts, requestChars: encoded.length,
    requestSha256: createHash('sha256').update(encoded).digest('hex'),
    ending: nextEnd?.data.reason, failedUsage: failed?.data.usage,
    failureBlockTypes: failedContent.map(b => b.type),
    inheritedSystemMessages: roles.system ?? 0, addedTestMessages: 0,
  };
  await writeFile(join(dir, 'request.json'), encoded);
  await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  results.push(summary);
  console.log(JSON.stringify({ case: summary.case, effort: summary.config?.reasoningEffort,
    model: summary.config?.model, requestChars: summary.requestChars, roles, blockCounts,
    foldError: summary.foldError, ending: summary.ending, failedUsage: summary.failedUsage }));
}
await writeFile(join(output, 'cases.json'), JSON.stringify(results, null, 2));
