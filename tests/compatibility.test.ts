import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaults } from '../src/config.js';
import { apply, type StabilizerAPI } from '../src/index.js';
import { compatibilityFor, releases } from '../src/compatibility.js';
import { FakeHost, chunks, makeAgent, repeated, stream } from './helpers.js';
import type { Chunk, RequestOptions, StepPayload } from '../src/types.js';
const active: FakeHost[] = [];
afterEach(async () => { for (const host of active.splice(0)) await host.close(); });
describe.each(releases)('DSH $version contract replay', release => {
  it('selects a verified protocol path and preserves every chunk', async () => {
    for (const name of ['stream', 'reasoningDelta', 'textDelta', 'blockEnd', 'toolResult', 'cancel', 'followup', 'preStep']) expect(release.features[name]).toBe(true);
    const host = new FakeHost(); active.push(host);
    apply(host, { hostVersion: release.version });
    const input = chunks(repeated).map(c => Object.freeze(c));
    const output = await stream(host, makeAgent(), input, release.adapter === 'live-frames');
    expect(output).toEqual(input);
    output.forEach((c, i) => expect(c).toBe(input[i]));
    expect(host.status().counts['stream-repeat']).toBeGreaterThanOrEqual(1);
    expect(host.status().compatibility.adapter).toBe(release.adapter);
  });
});
it('unrecognized versions get observation, never automatic intervention', () => {
  expect(compatibilityFor('9.9.9')).toMatchObject({ known: false, adapter: 'stream-waterfall', intervention: false });
  expect(compatibilityFor('')).toMatchObject({ version: 'unknown', intervention: false });
});
it('source-only and core mock-provider tests do not unlock live automatic recovery', () => {
  for (const release of releases) expect(compatibilityFor(release.version).intervention).toBe(false);
});
it('ignores auxiliary requests and other models', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  for (const override of [{ purpose: 'compaction' }, { model: 'other-model' }, { sessionId: 'other' }, { signal: new AbortController().signal }]) {
    await stream(host, makeAgent(), chunks(repeated), false, override);
  }
  expect(host.status().counts['stream-repeat'] ?? 0).toBe(0);
});
it.each(['deepseek-v4.1-flash', 'fixture:deepseek-v4.1-flash', 'fixture/nested/deepseek-v4.1-flash'])('observes the real Flash route %s', async model => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  await stream(host, makeAgent(), chunks(repeated), false, { model });
  expect(host.status().counts['stream-repeat']).toBeGreaterThanOrEqual(1);
});
it.each(['fixture:deepseek-v4.1-flash-extra', 'fixture:some-deepseek-v4.1-flash'])('does not match a partial Flash name %s', async model => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  await stream(host, makeAgent(), chunks(repeated), false, { model });
  expect(host.status().counts['stream-repeat'] ?? 0).toBe(0);
});
it('isolates sessions and discards pending state on unload', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  await Promise.all([stream(host, makeAgent('a'), chunks(repeated), false), stream(host, makeAgent('b'), chunks('normal answer'), false)]);
  expect(host.status().sessions).toBe(2);
  expect(host.status().counts['stream-repeat']).toBeGreaterThanOrEqual(1);
  await host.close(); expect(host.values.size).toBe(0); host.disposers.length = 0;
});
it('preserves upstream errors and downstream policy results', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  const failure = new Error('upstream failure');
  expect(() => host.waterfall('llm/stream', [{}], () => { throw failure; })).toThrow(failure);
});
it('keeps cordis.patch.yml models aligned with defaults.models', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  for (const model of defaults.models) expect(patch).toContain(`- ${model}`);
});
it('persists setSessionEnabled across pre-creation and agent instance recreation', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  const api = host.values.get('flashStabilizer') as StabilizerAPI;
  api.setSessionEnabled('s1', false);
  await stream(host, makeAgent('s1'), chunks(repeated), false);
  await stream(host, makeAgent('s1'), chunks(repeated), false);
  expect(host.status().counts['stream-repeat'] ?? 0).toBe(0);
  api.setSessionEnabled('s1', true);
  await stream(host, makeAgent('s1'), chunks(repeated), false);
  expect(host.status().counts['stream-repeat']).toBeGreaterThanOrEqual(1);
});
it('replaces the same session at capacity without evicting another session or losing monitoring', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7', maxSessions: 1 });
  await stream(host, makeAgent('same'), chunks('ordinary text'), false);
  await stream(host, makeAgent('same'), chunks(repeated), false);
  expect(host.status().sessions).toBe(1);
  expect(host.status().counts['internal-error'] ?? 0).toBe(0);
  expect(host.status().counts['stream-repeat']).toBeGreaterThanOrEqual(1);
});
it.each(['0.1.0-rc.7', '0.2.2-rc.1'])('keeps the newer request when an older stream finishes on %s', async hostVersion => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion });
  const agent = makeAgent();
  const modern = compatibilityFor(hostVersion).adapter === 'live-frames';
  const create = async (attemptId: string) => {
    const signal = new AbortController().signal;
    const step: StepPayload = { agent, turn: 1, step: 1, signal, messages: [] };
    await host.waterfall('agent/pre-step', [step], () => Promise.resolve());
    if (modern) host.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId } });
    async function* upstream(): AsyncGenerator<Chunk> {
      yield { type: 'reasoning-delta', index: 0, text: 'ordinary preamble\n' };
      yield { type: 'reasoning-delta', index: 0, text: repeated };
    }
    const options: RequestOptions = { sessionId: agent.id, provider: 'mock', model: 'deepseek-flash', signal };
    const iterator = (host.waterfall('llm/stream', [options], upstream) as AsyncIterable<Chunk>)[Symbol.asyncIterator]();
    const next = async () => {
      const result = await iterator.next();
      if (modern && !result.done) host.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId, chunk: result.value } });
      return result;
    };
    return { iterator, next };
  };
  const older = await create('older');
  await older.next();
  const newer = await create('newer');
  await newer.next();
  try {
    expect((await older.next()).value?.text).toBe(repeated);
    expect(host.status().confirmed).toBe(0);
    await older.iterator.return?.();
    expect(host.status().activeRequests).toBe(1);
    expect((await newer.next()).value?.text).toBe(repeated);
    expect(host.status().confirmed).toBe(1);
  } finally {
    await older.iterator.return?.();
    await newer.iterator.return?.();
  }
  expect(host.status()).toMatchObject({ monitoredRequests: 2, finishedRequests: 2, activeRequests: 0 });
});
it('does not activate a stale iterator after the next step has started', async () => {
  const host = new FakeHost(); active.push(host); apply(host, { hostVersion: '0.1.0-rc.7' });
  const agent = makeAgent();
  const signal = new AbortController().signal;
  const step: StepPayload = { agent, turn: 1, step: 1, signal, messages: [] };
  await host.waterfall('agent/pre-step', [step], () => Promise.resolve());
  async function* upstream() { yield* chunks(repeated); }
  const wrapped = host.waterfall('llm/stream', [{ sessionId: agent.id, model: 'deepseek-flash', signal }], upstream) as AsyncIterable<Chunk>;
  await host.waterfall('agent/pre-step', [{ ...step, step: 2, signal: new AbortController().signal }], () => Promise.resolve());
  const output: Chunk[] = [];
  for await (const chunk of wrapped) output.push(chunk);
  expect(output).toEqual(chunks(repeated));
  expect(host.status()).toMatchObject({ monitoredRequests: 0, finishedRequests: 0, activeRequests: 0, confirmed: 0 });
});
