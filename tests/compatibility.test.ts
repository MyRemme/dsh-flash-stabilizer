import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { defaults } from '../src/config.js';
import { apply, type StabilizerAPI } from '../src/index.js';
import { compatibilityFor, releases } from '../src/compatibility.js';
import { FakeHost, chunks, makeAgent, repeated, stream } from './helpers.js';
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
