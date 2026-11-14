import { expect, it } from 'vitest';
import { FenceFilter } from '../src/fences.js';
import { StreamMonitor } from '../src/monitor.js';
import { defaults } from '../src/config.js';
import { chunks } from './helpers.js';

it.each([1, 7, 73, 4096])('preserves invalid fence lines and filters only valid fenced content (%i)', size => {
  const input = 'before\r\n```inline```\r\n```bad`info\nplain\n```ts\r\nignored\r\n```\r\nafter\n~~~text\nignored too\n~~~\nend';
  const output: string[] = []; let boundaries = 0;
  const filter = new FenceFilter();
  for (let i = 0; i < input.length; i += size) filter.push(input.slice(i, i + size), text => { output.push(text); }, () => { boundaries++; });
  filter.finish(text => output.push(text));
  expect(output.join('')).toBe('before\r\n```inline```\r\n```bad`info\nplain\nafter\nend');
  expect(boundaries).toBe(4);
});

it('inspects pending prose before a fence opens in the same delta', () => {
  const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, event => events.push(event));
  monitor.push({ type: 'reasoning-delta', index: 0, text: '好。执行。好。'.repeat(120) });
  expect(events.some(event => event.confirmed)).toBe(false);
  monitor.push({ type: 'reasoning-delta', index: 0, text: '好。执行。好。'.repeat(28) + '\n```ts\nconst a = 1;\n```\n' });
  expect(events.some(event => event.confirmed)).toBe(true);
});

it.each([1, 73, 4096])('retains prose evidence across short fences and inline backtick lines (%i)', size => {
  for (const separator of ['\n```ts\nconst a = 1;\n```\n', '\n```inline```\n', '\n```bad`info\n']) {
    const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, event => events.push(event));
    chunks(('好。执行。好。'.repeat(40) + separator).repeat(20), size).forEach(chunk => monitor.push(chunk));
    expect(events.filter(event => event.confirmed), separator).toHaveLength(1);
  }
});

it.each([1, 73, 4096])('counts every unfenced character without including code (%i)', size => {
  const monitor = new StreamMonitor(defaults, () => {});
  chunks('a'.repeat(249) + '\n```text\nnot analyzed\n```\n' + 'b'.repeat(261), size).forEach(chunk => monitor.push(chunk));
  expect(monitor.snapshot().analyzedChars).toBe(511);
});

it('bounds an undecided opening line and exposes incomplete detection without treating it as a loop', () => {
  const monitor = new StreamMonitor(defaults, () => {});
  const text = '```' + 'x'.repeat(70000) + '`\n' + '好。执行。好。'.repeat(1000);
  chunks(text, 73).forEach(chunk => monitor.push(chunk));
  expect(monitor.snapshot()).toMatchObject({ reasoningChars: text.length, incomplete: true, incompleteReason: 'fence-limit', risk: 'incomplete' });
});
