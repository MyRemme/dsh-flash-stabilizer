import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelScopeStore, validateModelScope } from '../src/model-scope.js';
import { apply, type StabilizerAPI } from '../src/index.js';
import { FakeHost, makeAgent, chunks, repeated, stream } from './helpers.js';

const hosts: FakeHost[] = [], roots: string[] = [], stores: ModelScopeStore[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const initial = { scope: 'all' as const, selections: [] };
const route = { provider: 'fixture-channel', model: 'vendor/DeepSeek-Custom:fast' };
function setup(version = '0.1.0-rc.7') {
  const host = new FakeHost(); hosts.push(host); apply(host, { hostVersion: version, mode: 'assist' });
  return { host, api: host.values.get('flashStabilizer') as StabilizerAPI };
}
it.each(['0.1.0-rc.7', '0.2.2-rc.1'])('monitors every channel and model by default on %s', async version => {
  const { host, api } = setup(version), modern = version === '0.2.2-rc.1';
  for (const model of [route.model, 'fixture-unrelated-model', 'deepseek-flash-extra']) {
    const agent = makeAgent(model); agent.options = { ...route, model };
    await stream(host, agent, chunks(repeated), modern, { ...route, model });
    expect(api.sessionStatus(agent.id).confirmed).toBe(1);
    for (let i = 0; i < 4; i++) host.emit('tools/result', { agent, name: 'fixture', arguments: {} }, { isError: false, content: 'unchanged' });
    expect(api.sessionStatus(agent.id).toolWarnings).toBe(1);
  }
  expect(api.status().modelScope).toEqual({ scope: 'all', selectedCount: 0 });
  expect(JSON.stringify(api.status())).not.toContain(route.provider);
  expect(api.modelScope().availableModels.some(item => item.model === route.model)).toBe(true);
});
it('selects exact channel/model pairs, preserves choices in all mode and treats an empty selection as none', async () => {
  const { host, api } = setup();
  await api.setModelScope({ scope: 'selected', selections: [route] });
  for (const [id, selection, count] of [
    ['chosen', route, 1], ['different-channel', { ...route, provider: 'another-channel' }, 0],
    ['different-model', { ...route, model: route.model + '-extra' }, 0],
  ] as const) {
    const agent = makeAgent(id); agent.options = selection;
    await stream(host, agent, chunks(repeated), false, selection);
    expect(api.sessionStatus(id).confirmed).toBe(count);
    for (let i = 0; i < 4; i++) host.emit('tools/result', { agent, name: 'fixture', arguments: {} }, { isError: false });
    expect(api.sessionStatus(id).toolWarnings).toBe(count);
  }
  await api.setModelScope({ scope: 'all', selections: [route] });
  expect(api.modelScope().selections).toEqual([route]);
  await api.setModelScope({ scope: 'selected', selections: [] });
  await stream(host, makeAgent('none'), chunks(repeated), false, route);
  expect(api.sessionStatus('none').coverage).toBe('other-model');
});
it.each(['0.1.0-rc.7', '0.2.2-rc.1'])('revokes pending correction and stops tracking an excluded stream without cancelling output (%s)', async version => {
  const { host, api } = setup(version), modern = version === '0.2.2-rc.1';
  const signal = new AbortController().signal; let followups = 0, cancels = 0;
  const agent = { ...makeAgent('running'), options: route, followup: () => { followups++; }, cancel: () => { cancels++; } };
  await host.waterfall('agent/pre-step', [{ agent, signal, turn: 1, step: 1, messages: [], modelSelection: route }], async () => {});
  if (modern) host.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'fixture' } });
  async function* upstream() { yield { type: 'reasoning-delta', index: 0, text: repeated }; yield { type: 'text-delta', index: 1, text: 'still delivered' }; }
  const iterator = host.waterfall('llm/stream', [{ ...route, sessionId: agent.id, signal }], upstream)[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (modern) host.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'fixture', chunk: first.value } });
  expect(api.sessionStatus(agent.id).latestEvent?.action).toBe('correction-deferred');
  await api.setModelScope({ scope: 'selected', selections: [] });
  expect(api.sessionStatus(agent.id).coverage).toBe('other-model');
  expect((await iterator.next()).value.text).toBe('still delivered'); await iterator.next();
  host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  agent.status = 'idle'; host.emit('agent/status', { agent, status: 'idle' }); await Promise.resolve();
  expect(followups).toBe(0); expect(cancels).toBe(0);
});
it('does not activate an excluded iterator that was created before the scope change', async () => {
  const { host, api } = setup(), agent = makeAgent(), signal = new AbortController().signal;
  await host.waterfall('agent/pre-step', [{ agent, signal, turn: 1, step: 1, messages: [] }], async () => {});
  async function* upstream() { yield* chunks(repeated); }
  const wrapped = host.waterfall('llm/stream', [{ ...route, sessionId: agent.id, signal }], upstream);
  await api.setModelScope({ scope: 'selected', selections: [] });
  const output = []; for await (const chunk of wrapped) output.push(chunk);
  expect(output).toEqual(chunks(repeated)); expect(api.status().monitoredRequests).toBe(0);
});
it('persists scope across reloads, validates input and keeps live settings if saving fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flash-scope-')); roots.push(directory);
  let changes = 0;
  const first = new ModelScopeStore(initial, directory, () => { changes++; }); stores.push(first);
  await first.set({ scope: 'selected', selections: [route, route] }); expect(changes).toBe(1);
  const reloaded = new ModelScopeStore(initial, directory, () => {}); stores.push(reloaded);
  expect(reloaded.view().selections).toEqual([route]); expect(reloaded.matches(route)).toBe(true);
  expect(reloaded.matches({ ...route, provider: 'other' })).toBe(false);
  for (const value of [{}, { scope: 'other', selections: [] }, { scope: 'all', selections: [{ model: '' }] },
    { scope: 'all', selections: [{ ...route, token: 'no' }] }, { scope: 'all', selections: [], extra: true }]) expect(() => validateModelScope(value)).toThrow();
  const blocked = join(directory, 'blocked'); await writeFile(blocked, 'not a directory');
  const broken = new ModelScopeStore(initial, blocked, () => {}); stores.push(broken);
  await expect(broken.set({ scope: 'selected', selections: [route] })).rejects.toThrow();
  expect(broken.summary().scope).toBe('all');
});
it('offers host catalog and observed routes, tolerates a failing channel and returns detached snapshots', async () => {
  const store = new ModelScopeStore(initial, undefined, () => {}); stores.push(store);
  store.remember(route);
  const view = await store.refresh({ listProviders: () => [{ id: 'catalog', name: '合成渠道' }, { id: 'offline' }],
    listModels: async provider => { if (provider === 'offline') throw Error('private error'); return [{ id: 'model-a', name: '模型 A' }]; } });
  expect(view.catalogError).toBe(true);
  expect(view.availableModels).toEqual(expect.arrayContaining([expect.objectContaining(route), expect.objectContaining({ model: 'model-a', provider: 'catalog' })]));
  view.availableModels[0]!.model = 'mutated'; expect(store.view().availableModels[0]!.model).toBe(route.model);
  expect(JSON.stringify(view)).not.toContain('private error');
});
it('restores the saved profile scope before the first request after plugin reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flash-scope-reload-')); roots.push(directory);
  const first = new FakeHost(); hosts.push(first); first.values.set('profileContext', { dir: directory });
  apply(first, { hostVersion: '0.1.0-rc.7' });
  await (first.values.get('flashStabilizer') as StabilizerAPI).setModelScope({ scope: 'selected', selections: [route] });
  const reloaded = new FakeHost(); hosts.push(reloaded); reloaded.values.set('profileContext', { dir: directory });
  apply(reloaded, { hostVersion: '0.1.0-rc.7', modelScope: 'all' });
  const api = reloaded.values.get('flashStabilizer') as StabilizerAPI;
  expect(api.status().modelScope).toEqual({ scope: 'selected', selectedCount: 1 });
  expect(api.modelScope().persistent).toBe(true);
  await stream(reloaded, makeAgent('excluded-after-reload'), chunks(repeated), false, { ...route, provider: 'other' });
  await stream(reloaded, makeAgent('included-after-reload'), chunks(repeated), false, route);
  expect(api.sessionStatus('excluded-after-reload').monitoredRequests).toBe(0);
  expect(api.sessionStatus('included-after-reload').confirmed).toBe(1);
});
