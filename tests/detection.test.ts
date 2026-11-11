import { describe, expect, it } from 'vitest';
import { defaults, resolveSettings, Config } from '../src/config.js';
import { StreamMonitor } from '../src/monitor.js';
import { periodicSuffix } from '../src/detection.js';
import { chunks, repeated } from './helpers.js';

describe('repeat evidence', () => {
  it.each([1, 7, 73, 4096, 20000])('recognizes a loop independent of delta size %i', size => {
    const events: { confirmed: boolean }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks(repeated, size).forEach(c => monitor.push(c));
    expect(events.filter(e => e.confirmed)).toHaveLength(1);
  });
  it.each(['甲乙丙丁戊己庚辛壬癸，继续验证。', 'A: inspect the data. B: reconsider the same evidence. ', 'A: inspect. B: reconsider. C: restart the same investigation. '])('detects stable cycles', unit => {
    const e = periodicSuffix(unit.repeat(200).slice(-4096), 8, 512, 6);
    expect(e.coverage).toBeGreaterThan(0.85);
  });
  it.each(['好。执行。好。', 'Write. / Output. / Let me write.'])('confirms short rotating phrases: %s', unit => {
    for (const size of [1, 7, 73, 4096]) {
      const events: { confirmed: boolean }[] = [];
      const monitor = new StreamMonitor(defaults, e => events.push(e));
      chunks(unit.repeat(1200), size).forEach(c => monitor.push(c));
      expect(events.filter(e => e.confirmed)).toHaveLength(1);
    }
  });
  it.each(['哈。', '1234567890'])('does not confirm single-letter or numeric-only spam: %s', unit => {
    const events: { confirmed: boolean }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks(unit.repeat(2000)).forEach(c => monitor.push(c));
    expect(events.some(e => e.confirmed)).toBe(false);
  });
  it('does not interrupt long, changing reasoning', () => {
    const events: { confirmed: boolean }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    const text = Array.from({ length: 300 }, (_, i) => `${i}：新增证据${i * i}，可排除假设${i + 1}，下一步检查路径${i.toString(36)}。`).join('\n');
    chunks(text).forEach(c => monitor.push(c));
    expect(events.some(e => e.confirmed)).toBe(false);
  });
  it.each([1, 2, 73, 4096])('exempts fenced repeated code across chunk boundaries %i', size => {
    const events: { confirmed: boolean }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks('```text\n' + repeated + '\n```', size, 'text').forEach(c => monitor.push(c));
    expect(events.some(e => e.confirmed)).toBe(false);
  });
  it('does not join independent blocks or inspect tool JSON', () => {
    const events: unknown[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    for (let i = 0; i < 20; i++) {
      monitor.push({ type: 'text-delta', index: i, text: repeated.slice(0, 300) });
      monitor.push({ type: 'block-end', index: i, block: { type: 'text', text: repeated.slice(0, 300) } });
    }
    monitor.push({ type: 'tool-call-delta', index: 50, argumentsDelta: repeated });
    expect(events).toEqual([]);
  });
  it('never double-counts block-end text', () => {
    const events: unknown[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    monitor.push({ type: 'reasoning-delta', index: 0, text: repeated.slice(0, 900) });
    monitor.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: repeated.slice(0, 900) } });
    expect(events).toEqual([]);
  });
  it('accepts block-end-only streams without mutating chunks', () => {
    const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    const chunk = Object.freeze({ type: 'block-end', index: 0, block: Object.freeze({ type: 'reasoning', text: repeated }) });
    monitor.push(chunk);
    expect(events.some(e => e.confirmed)).toBe(true);
  });
  it('requires new evidence, and does not treat punctuation spam as a confirmed semantic loop', () => {
    const events: unknown[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks('。'.repeat(10000)).forEach(c => monitor.push(c));
    expect(events).toEqual([]);
  });
});
describe('configuration', () => {
  it('validates defaults using Standard Schema', () => expect(Config['~standard'].validate({})).toEqual({ value: defaults }));
  it.each([{ mode: 'unsafe' }, { minChars: 0 }, { confirmations: 1 }, { maxRecoveries: 99 }, { models: [] as unknown as string, unknown: 2 }, { windowChars: 1e9 }])('rejects invalid configuration %j', config => {
    expect(() => resolveSettings(config)).toThrow();
  });
});
