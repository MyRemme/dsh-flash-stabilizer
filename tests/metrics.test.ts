import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { MetricsStore } from '../src/metrics.js';
it('bounds logs, anonymizes identifiers and drains on unload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stabilizer-test-'));
  try {
    let count = 0;
    for (let batch = 0; batch < 5; batch++) {
      const metrics = new MetricsStore(directory, 4096, () => {});
      for (let i = 0; i < 80; i++) metrics.record({ kind: 'stream-repeat', session: 'secret-session-name', score: 98, confirmed: true, chars: 2000 });
      // Close flushes all admitted events; each store shares the bounded files.
      await metrics.close();
      count += metrics.counts['stream-repeat'] ?? 0;
    }
    const files = await readdir(directory);
    expect(files.length).toBeLessThanOrEqual(2);
    for (const file of files) expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(4096);
    const content = await readFile(join(directory, 'events.jsonl'), 'utf8');
    expect(content).not.toContain('secret-session-name');
    expect(content).toContain('stream-repeat');
    expect(count).toBe(400);
    expect(files).toContain('events.previous.jsonl');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('contains logging failure without retrying indefinitely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stabilizer-error-'));
  try {
    const file = join(directory, 'not-directory'); await writeFile(file, 'x');
    const warn = vi.fn(), metrics = new MetricsStore(file, 4096, warn);
    metrics.record({ kind: 'internal-error', session: '', score: 0, confirmed: false, chars: 0 });
    await metrics.close();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(metrics.snapshot().logging).toMatchObject({ enabled: true, healthy: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('bounds and clones UI history while keeping lifetime totals and stripping unexpected fields', async () => {
  const metrics = new MetricsStore('', 4096, () => {});
  for (let i = 0; i < 120; i++) {
    metrics.record({ kind: 'recovery', session: 'private', score: 0, confirmed: false, chars: 0, action: 'recovery-submitted', ...{ raw: 'secret' } });
  }
  const snapshot = metrics.snapshot();
  expect(snapshot.recoverySubmitted).toBe(120);
  expect(snapshot.events).toHaveLength(100);
  expect(snapshot.logging.enabled).toBe(false);
  expect(JSON.stringify(snapshot)).not.toMatch(/private|secret/);
  snapshot.events[0]!.action = 'changed';
  expect(metrics.snapshot().events[0]!.action).toBe('recovery-submitted');
  await metrics.close();
});
