import { afterEach, expect, it } from 'vitest';
import { apply, type StabilizerAPI } from '../src/index.js';
import type { ConnectionService, HostContext } from '../src/types.js';
import { FakeHost, chunks, makeAgent, repeated, stream } from './helpers.js';

const hosts: FakeHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
function setup() {
  const host = new FakeHost(); hosts.push(host);
  let handler: Parameters<ConnectionService['rpc']['handle']>[1];
  const connection = { rpc: { handle: (channel: string, fn: typeof handler) => { expect(channel).toBe('/flash-stabilizer'); handler = fn; } } };
  (host as HostContext).inject = (names, callback) => { expect(names).toEqual(['connection', 'webServer']); callback(Object.assign(host, { connection })); };
  apply(host, { hostVersion: '0.1.0-rc.7', mode: 'assist' });
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
  expect(call('setMonitoring', { enabled: false }, 'owner', AbortSignal.abort()).error?.code).toBe('ABORTED');
  expect(call('setMonitoring', { enabled: false }).value.monitoring).toBe(false);
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
  host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  agent.status = 'idle'; host.emit('agent/status', { agent, status: 'idle' });
  await Promise.resolve(); expect(followed).toBe(0);
  await stream(host, makeAgent('paused'), chunks(repeated), false);
  expect(api.status().monitoredRequests).toBe(1);
  call('setMonitoring', { enabled: true });
  await stream(host, makeAgent('resumed'), chunks('ordinary content'), false);
  expect(api.status().monitoredRequests).toBe(2);
});
