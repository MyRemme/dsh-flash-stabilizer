import { afterEach, expect, it, vi } from 'vitest';
import { apply, type StabilizerAPI } from '../src/index.js';
import type { ConnectionService, HostContext } from '../src/types.js';
import { FakeHost, chunks, makeAgent, repeated, stream } from './helpers.js';

const hosts: FakeHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); vi.useRealTimers(); });
function setup() {
  const host = new FakeHost(); hosts.push(host);
  let handler: Parameters<ConnectionService['rpc']['handle']>[1];
  const connection = { rpc: { handle: (channel: string, fn: typeof handler) => { expect(channel).toBe('/flash-stabilizer'); handler = fn; } } };
  (host as HostContext).inject = (names, callback) => {
    if (names.includes('pluginManager')) return;
    expect(names).toEqual(['connection', 'webServer']); callback(Object.assign(host, { connection }));
  };
  apply(host, { hostVersion: '0.1.0-rc.7', mode: 'assist', modelScope: 'selected', models: ['deepseek-flash'] });
  const api = host.values.get('flashStabilizer') as StabilizerAPI;
  const call = (endpoint: string, payload: unknown = {}, kind = 'owner', signal = new AbortController().signal) =>
    handler(endpoint, payload, signal, { principal: { kind } }) as { ok: boolean; value?: any; error?: { code: string } };
  return { host, api, call };
}
it('requires an owner and validates every UI operation before changing state', () => {
  const { api, call } = setup();
  expect(call('setMonitoring', { enabled: false }, 'guest').error?.code).toBe('FORBIDDEN');
  expect(api.status().monitoring).toBe(true);
  for (const payload of [null, [], { enabled: 'false' }, { enabled: false, path: '/etc' }]) expect(call('setMonitoring', payload).ok).toBe(false);
  expect(call('snapshot', { extra: true }).ok).toBe(false);
  expect(call('unknown').error?.code).toBe('NOT_FOUND');
  expect(call('installUpdate', {}, 'guest').error?.code).toBe('FORBIDDEN');
  expect(call('checkUpdates', { url: 'https://untrusted.invalid/' }).error?.code).toBe('BAD_REQUEST');
  expect(call('setAutomaticUpdates', { enabled: 'yes' }).error?.code).toBe('BAD_REQUEST');
  expect(call('updates').value.phase).toBe('unavailable');
  expect(call('setMonitoring', { enabled: false }, 'owner', AbortSignal.abort()).error?.code).toBe('ABORTED');
  expect(call('setMonitoring', { enabled: false }).value.monitoring).toBe(false);
});
it('restricts model selection to the owner and omits route names from exports', async () => {
  const { api, call } = setup();
  expect(call('modelScope', {}, 'guest').error?.code).toBe('FORBIDDEN');
  expect(call('refreshModels', {}, 'guest').error?.code).toBe('FORBIDDEN');
  expect(call('setModelScope', { scope: 'all', selections: [] }, 'guest').error?.code).toBe('FORBIDDEN');
  for (const payload of [{}, { scope: 'some', selections: [] }, { scope: 'all', selections: ['model'] },
    { scope: 'selected', selections: [], extra: true }]) expect(call('setModelScope', payload).error?.code).toBe('BAD_REQUEST');
  expect(call('setModelScope', { scope: 'all', selections: [] }, 'owner', AbortSignal.abort()).error?.code).toBe('ABORTED');
  const selection = { provider: 'private-fixture-channel', model: 'private-fixture-model' };
  expect((await call('setModelScope', { scope: 'selected', selections: [selection] })).ok).toBe(true);
  expect(api.modelScope().selections).toEqual([selection]);
  expect(call('modelScope').value.selections).toEqual([selection]);
  expect(JSON.stringify(call('export'))).not.toContain(selection.provider);
  expect(JSON.stringify(call('snapshot'))).not.toContain(selection.model);
});
it('limits raw conversation navigation ids to the owner UI endpoint and keeps export redacted', async () => {
  const { host, call } = setup();
  expect(call('conversations', {}, 'guest').error?.code).toBe('FORBIDDEN');
  expect(call('conversations', { extra: true }).error?.code).toBe('BAD_REQUEST');
  const agent = makeAgent('private-ui-navigation');
  await stream(host, agent, chunks(repeated), false);
  const list = call('conversations').value;
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ sessionId: 'private-ui-navigation', tracked: true, turn: 1, step: 1, confirmed: 1 });
  const event = list[0].events.find((e: { confirmed: boolean }) => e.confirmed);
  expect(event.session).toBe(list[0].sessionKey);
  expect(event.coverage).toBeGreaterThanOrEqual(0.85);
  expect(event.novelty).toBeLessThanOrEqual(0.15);
  host.emit('agent/disposed', { agent });
  expect(call('conversations').value[0]).toMatchObject({ sessionId: agent.id, tracked: false, confirmed: 1, counterScope: 'retained-events' });
  expect(JSON.stringify(call('export').value)).not.toContain('private-ui-navigation');
  expect(JSON.stringify(call('snapshot').value)).not.toContain('private-ui-navigation');
});
it('streams per-request activity without treating silence, short output or interruption as clean detection', async () => {
  vi.useFakeTimers();
  const { host, api } = setup(), agent = makeAgent('live'), controller = new AbortController();
  host.emit('agent/pre-step', { agent, turn: 8, step: 3, signal: controller.signal, messages: [] }, () => Promise.resolve());
  async function* upstream() {
    yield { type: 'reasoning-delta', index: 0, text: '正在检查。' };
    yield { type: 'reasoning-delta', index: 0, text: Array.from({ length: 200 }, (_, i) => `Changed evidence ${i} excludes ${i * i}; continue module ${i + 1}.`).join(' ') };
    yield { type: 'reasoning-delta', index: 0, text: repeated };
    yield { type: 'finish' };
  }
  const iterator = host.waterfall('llm/stream', [{ sessionId: 'live', model: 'deepseek-flash', signal: controller.signal }], () => upstream())[Symbol.asyncIterator]();
  await iterator.next();
  expect(api.sessionStatus('live').live).toMatchObject({ risk: 'collecting', active: true, turn: 8, step: 3, checks: 0 });
  vi.advanceTimersByTime(31000);
  expect(api.sessionStatus('live').live?.silentForMs).toBe(31000);
  await iterator.next();
  expect(api.sessionStatus('live').live).toMatchObject({ risk: 'clear', active: true, silentForMs: 0 });
  expect(api.sessionStatus('live').live!.checks).toBeGreaterThan(0);
  await iterator.next();
  expect(api.sessionStatus('live').live?.risk).toBe('confirmed');
  const before = api.sessionStatus('live').live!;
  api.setMonitoring(false); api.setMonitoring(true);
  await iterator.next(); await iterator.next();
  expect(api.sessionStatus('live')).toMatchObject({ coverage: 'unavailable', live: { active: false, checks: before.checks } });
});
it('shows actual monitored requests, redacts diagnostics and isolates offline self-test', async () => {
  const { host, api, call } = setup();
  const before = api.status();
  expect(call('selfTest').value).toEqual({ passed: true, scope: 'offline-detector-only', modelRequests: 0 });
  expect(api.status()).toEqual(before);
  const agent = makeAgent('private-session-name'); agent.followup = () => {};
  await stream(host, agent, chunks(repeated), false);
  const value = call('snapshot').value;
  expect(value).toMatchObject({ monitoredRequests: 1, finishedRequests: 1, activeRequests: 0, confirmed: 1, recoverySubmitted: 0 });
  expect(value.lastMonitoredAt).toBeTruthy();
  expect(value.events.some((e: { action?: string }) => e.action === 'correction-deferred')).toBe(true);
  const exported = JSON.stringify(call('export').value);
  expect(exported).not.toContain('private-session-name');
  expect(exported).not.toContain(repeated.slice(0, 100));
  expect(exported).toContain('schemaVersion');
});
it('pausing revokes pending corrections and does not cancel the model or consume tools', async () => {
  const { host, api, call } = setup();
  const agent = makeAgent();
  let followed = 0; agent.followup = () => { followed++; };
  await stream(host, agent, chunks(repeated), false);
  call('setMonitoring', { enabled: false });
  expect(api.sessionStatus(agent.id).latestEvent?.action).toBe('correction-revoked');
  host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  agent.status = 'idle'; host.emit('agent/status', { agent, status: 'idle' });
  await Promise.resolve(); expect(followed).toBe(0);
  await stream(host, makeAgent('paused'), chunks(repeated), false);
  expect(api.status().monitoredRequests).toBe(1);
  call('setMonitoring', { enabled: true });
  await stream(host, makeAgent('resumed'), chunks('ordinary content'), false);
  expect(api.status().monitoredRequests).toBe(2);
});
it('attributes a delayed old stream to its captured turn and step', async () => {
  const { host, api } = setup(), agent = makeAgent('overlap'), controller = new AbortController();
  const step = (turn: number, index: number) => host.emit('agent/pre-step', { agent, turn, step: index, signal: controller.signal, messages: [] }, () => Promise.resolve());
  step(3, 1);
  async function* upstream() { yield { type: 'text-delta', index: 0, text: 'preamble' }; yield { type: 'reasoning-delta', index: 1, text: repeated }; }
  const iterator = host.waterfall('llm/stream', [{ sessionId: agent.id, model: 'deepseek-flash', signal: controller.signal }], () => upstream())[Symbol.asyncIterator]();
  await iterator.next(); step(4, 2); await iterator.next();
  expect(api.sessionStatus(agent.id).events.find(e => e.confirmed)).toMatchObject({ turn: 3, step: 1 });
  await iterator.return();
});
it('validates the per-session endpoint and isolates each conversation without exporting raw ids', async () => {
  const { host, api, call } = setup();
  for (const payload of [{}, { sessionId: '' }, { sessionId: 2 }, { sessionId: 'a', extra: true }, { sessionId: 'x'.repeat(1025) }]) expect(call('session', payload).error?.code).toBe('BAD_REQUEST');
  expect(call('session', { sessionId: 'a' }, 'guest').error?.code).toBe('FORBIDDEN');
  expect(call('session', { sessionId: 'a' }).value).toMatchObject({ coverage: 'waiting', monitoredRequests: 0, confirmed: 0, events: [] });
  const a = makeAgent('private-a'); a.followup = () => {};
  await stream(host, a, chunks(repeated), false);
  await stream(host, makeAgent('private-b'), chunks('ordinary output'), false);
  const own = call('session', { sessionId: a.id }).value;
  expect(own).toMatchObject({ coverage: 'checked', monitoredRequests: 1, confirmed: 1, cancelRequested: 0, recoverySubmitted: 0 });
  expect(own.events.find((event: { confirmed: boolean }) => event.confirmed)).toMatchObject({ contentType: 'reasoning', turn: 1, step: 1 });
  expect(own.latestEvent).toMatchObject({ kind: 'recovery', action: 'correction-deferred' });
  expect(JSON.stringify(own)).not.toContain('private-a');
  expect(call('session', { sessionId: 'private-b' }).value).toMatchObject({ coverage: 'checked', confirmed: 0, events: [] });
  await stream(host, makeAgent('private-c'), chunks(repeated), false, { model: 'other' });
  expect(api.sessionStatus('private-c')).toMatchObject({ coverage: 'other-model', monitoredRequests: 0 });
  api.setSessionEnabled('private-b', false);
  expect(api.sessionStatus('private-b').coverage).toBe('disabled');
  api.setMonitoring(false);
  expect(api.sessionStatus('private-a').coverage).toBe('paused');
});
it('resets current-request evidence but retains historical incidents and reports missing coverage honestly', async () => {
  const { host, api } = setup();
  const agent = makeAgent('a');
  await stream(host, agent, chunks(repeated), false);
  expect(api.sessionStatus('a').latestEvent).not.toBeNull();
  await stream(host, agent, chunks('ordinary output'), false);
  expect(api.sessionStatus('a')).toMatchObject({ coverage: 'checked', latestEvent: null, confirmed: 1, monitoredRequests: 2 });
  expect(api.sessionStatus('a').events.length).toBeGreaterThan(0);
  await stream(host, agent, chunks('auxiliary'), false, { purpose: 'summary' });
  expect(api.sessionStatus('a').coverage).toBe('checked');
  await stream(host, agent, chunks('unmatched signal'), false, { signal: new AbortController().signal });
  expect(api.sessionStatus('a').coverage).toBe('unavailable');
  await stream(host, makeAgent('aux'), chunks('auxiliary'), false, { purpose: 'summary' });
  expect(api.sessionStatus('aux').coverage).toBe('auxiliary');
});
it('does not report a fully checked request when monitoring was paused midstream', async () => {
  const { host, api } = setup();
  const agent = makeAgent('a'), controller = new AbortController();
  host.emit('agent/pre-step', { agent, turn: 1, step: 1, signal: controller.signal, messages: [] }, () => Promise.resolve());
  async function* upstream() { yield { type: 'text-delta', index: 0, text: 'hello' }; yield { type: 'finish' }; }
  const iterator = host.waterfall('llm/stream', [{ sessionId: 'a', model: 'deepseek-flash', signal: controller.signal }], () => upstream())[Symbol.asyncIterator]();
  await iterator.next();
  expect(api.sessionStatus('a').coverage).toBe('monitoring');
  api.setMonitoring(false); api.setMonitoring(true);
  await iterator.next(); await iterator.next();
  expect(api.sessionStatus('a').coverage).toBe('unavailable');
});
