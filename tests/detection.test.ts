import { describe, expect, it, vi } from 'vitest';
import { defaults, resolveSettings, Config } from '../src/config.js';
import { StreamMonitor } from '../src/monitor.js';
import { periodicSuffix, RepeatDetector } from '../src/detection.js';
import { FenceFilter } from '../src/fences.js';
import { chunks, repeated } from './helpers.js';

describe('repeat evidence', () => {
  it('reports only content-free live counters, avoids block-end double counts, and keeps counting after confirmation', () => {
    const monitor = new StreamMonitor(defaults, () => {});
    const text = '好。执行。好。'.repeat(1500);
    const input = chunks(text, 73);
    input.forEach(chunk => monitor.push(chunk));
    const live = monitor.snapshot();
    expect(live).toMatchObject({ reasoningChars: text.length, textChars: 0, risk: 'confirmed' });
    expect(live.checks).toBeGreaterThan(0);
    expect(live.analyzedChars).toBeLessThan(text.length);
    expect(JSON.stringify(live)).not.toContain('好。');
    monitor.push({ type: 'text-delta', index: 1, text: 'new body' });
    expect(monitor.snapshot()).toMatchObject({ textChars: 8, checks: live.checks, risk: 'confirmed' });
  });
  it('counts block-end-only output and distinguishes insufficient samples from checked prose', () => {
    const monitor = new StreamMonitor(defaults, () => {});
    monitor.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'short answer' } });
    expect(monitor.snapshot()).toMatchObject({ risk: 'collecting', checks: 0, textChars: 12 });
    monitor.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'short answer' } });
    expect(monitor.snapshot().textChars).toBe(12);
  });
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
  it.each(['a!b?', '𐐀!𐐁?', '𐐀!a?', 'a!𐐀?'])('preserves the shortest full-coverage period with Unicode letters: %s', unit => {
    const text = unit.repeat(300);
    const period = Math.ceil(16 / unit.length) * unit.length;
    expect(periodicSuffix(text, 16, 512, 6)).toEqual({ period, repeats: Math.floor(text.length / period), coverage: 1 });
  });
  it('does not count a clipped surrogate or repeated copies of one letter as two letters', () => {
    for (const unit of ['𐐀!', 'a!', '123!', '。。。']) {
      expect(periodicSuffix(unit.repeat(300), 16, 512, 6)).toEqual({ period: 0, repeats: 0, coverage: 0 });
    }
  });
  it('stops inspecting the current delta and all later chunks once confirmed', () => {
    const inspect = vi.spyOn(RepeatDetector.prototype, 'push');
    const filter = vi.spyOn(FenceFilter.prototype, 'push');
    try {
      let confirmedAt = 0;
      const monitor = new StreamMonitor(defaults, e => { if (e.confirmed) confirmedAt = inspect.mock.calls.length; });
      monitor.push({ type: 'reasoning-delta', index: 0, text: repeated.repeat(20) });
      expect(confirmedAt).toBeGreaterThan(0);
      expect(inspect).toHaveBeenCalledTimes(confirmedAt);
      const filtered = filter.mock.calls.length;
      for (const chunk of chunks(repeated.repeat(20), 4096)) monitor.push(chunk);
      expect(inspect).toHaveBeenCalledTimes(confirmedAt);
      expect(filter).toHaveBeenCalledTimes(filtered);
    } finally { inspect.mockRestore(); filter.mockRestore(); }
  });
  it('can stop fence parsing immediately when its consumer is done', () => {
    const filter = new FenceFilter();
    const emitted: string[] = [];
    filter.push('ordinary text\n'.repeat(10000), text => { emitted.push(text); return emitted.length < 3; }, () => {});
    expect(emitted.join('')).toBe('ord');
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
  it('does not go blind after an inline triple-backtick mention in reasoning', () => {
    const events: { confirmed: boolean }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks('先检查字符串中是否包含 ``` 分隔符。\n' + '好。执行。好。'.repeat(600), 73, 'reasoning').forEach(c => monitor.push(c));
    expect(events.filter(e => e.confirmed)).toHaveLength(1);
  });
  it('confirms short period phrases after a non-repeating preamble without harmonic resets', () => {
    const events: { confirmed: boolean; chars: number }[] = [];
    const monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks('先正常分析当前模块依赖与构建配置。\n' + '好。执行。好。'.repeat(500), 73, 'reasoning').forEach(c => monitor.push(c));
    expect(events.filter(e => e.confirmed)).toHaveLength(1);
    expect(events.find(e => e.confirmed)!.chars).toBeLessThan(3200);
  });
  it('still inspects block-end text if only an empty delta preceded it', () => {
    const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    monitor.push({ type: 'reasoning-delta', index: 0, text: '' });
    monitor.push({ type: 'block-end', index: 0, block: { type: 'reasoning', text: repeated } });
    expect(events.some(e => e.confirmed)).toBe(true);
  });
  it.each([1, 2, 73, 4096])('respects fence lengths, markers, and trailing text across %i-character deltas', size => {
    for (const [open, falseClose, close] of [
      ['````text', '```', '````'], ['```text', '```not-a-closer', '```'],
      ['~~~text', '```', '~~~'], ['~~~~text', '~~~', '~~~~'],
      ['   ```text', '    ```', '   ```'], ['```text', '``` ~', '```'],
    ]) {
      const prefix = `${open}\r\nordinary code\r\n${falseClose}\r\n${repeated}\r\n`;
      const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
      chunks(prefix, size, 'text').slice(0, -2).forEach(c => monitor.push(c));
      expect(events.some(e => e.confirmed)).toBe(false);
      const suffix = `${close}\r\n${repeated}`;
      for (let n = 0; n < suffix.length; n += size) monitor.push({ type: 'text-delta', index: 0, text: suffix.slice(n, n + size) });
      expect(events.some(e => e.confirmed)).toBe(true);
    }
  });
  it.each(['prefix ``` mention\n', 'prefix ~~~ mention\n', '```bad`info\n', '\t```text\n', '    ```text\n'])('does not open a fence for %j', prefix => {
    const events: { confirmed: boolean }[] = [], monitor = new StreamMonitor(defaults, e => events.push(e));
    chunks(prefix + repeated, 1).forEach(c => monitor.push(c));
    expect(events.some(e => e.confirmed)).toBe(true);
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
