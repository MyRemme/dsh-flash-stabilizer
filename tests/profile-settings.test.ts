import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, type StabilizerAPI } from '../src/index.js';
import { ModelScopeStore } from '../src/model-scope.js';
import { FakeHost } from './helpers.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const roots: string[] = [], hosts: FakeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() { const root = await mkdtemp(join(tmpdir(), 'flash-settings-')); roots.push(root); return root; }

it.skipIf(process.platform !== 'win32')('preserves mode changes through a transient Windows destination lock and reload', async () => {
  const dir = await directory(), host = new FakeHost(); hosts.push(host);
  host.values.set('profileContext', { dir }); apply(host);
  const api = host.values.get('flashStabilizer') as StabilizerAPI;
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Destination is open'), { code: 'EPERM' }));
  await expect(api.setMode('assist')).resolves.toMatchObject({ mode: 'assist' });
  const reloaded = new FakeHost(); hosts.push(reloaded);
  reloaded.values.set('profileContext', { dir }); apply(reloaded);
  expect((reloaded.values.get('flashStabilizer') as StabilizerAPI).status().mode).toBe('assist');
});
it.skipIf(process.platform !== 'win32')('preserves model selection through a transient Windows destination lock and reload', async () => {
  const dir = await directory(), changed = vi.fn();
  const initial = { scope: 'all' as const, selections: [] };
  const store = new ModelScopeStore(initial, dir, changed);
  const selection = { scope: 'selected', selections: [{ provider: 'fixture', model: 'synthetic-model' }] };
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Destination is open'), { code: 'EACCES' }));
  await expect(store.set(selection)).resolves.toMatchObject(selection);
  expect(changed).toHaveBeenCalledTimes(1); await store.close();
  const reloaded = new ModelScopeStore(initial, dir, () => {});
  expect(reloaded.view()).toMatchObject({ ...selection, persistent: true, loadError: false });
  expect(JSON.parse(await readFile(join(dir, '.flash-stabilizer/model-scope.json'), 'utf8'))).toEqual(selection);
  await reloaded.close();
});
it.each(['mode', 'scope'])('keeps the previous %s settings on a permanent write failure and removes temporary files', async target => {
  const dir = await directory(), host = new FakeHost(); hosts.push(host);
  host.values.set('profileContext', { dir }); apply(host);
  const api = host.values.get('flashStabilizer') as StabilizerAPI;
  await api.setMode('observe'); await api.setModelScope({ scope: 'all', selections: [] });
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('I/O failure'), { code: 'EIO' }));
  if (target === 'mode') {
    await expect(api.setMode('assist')).rejects.toMatchObject({ code: 'EIO' });
    expect(api.status().mode).toBe('observe');
    expect(JSON.parse(await readFile(join(dir, '.flash-stabilizer/mode.json'), 'utf8'))).toEqual({ mode: 'observe' });
  } else {
    await expect(api.setModelScope({ scope: 'selected', selections: [] })).rejects.toMatchObject({ code: 'EIO' });
    expect(api.modelScope().scope).toBe('all');
    expect(JSON.parse(await readFile(join(dir, '.flash-stabilizer/model-scope.json'), 'utf8'))).toEqual({ scope: 'all', selections: [] });
  }
  expect((await readdir(join(dir, '.flash-stabilizer'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
});
it('serializes concurrent mode and scope changes and reloads the final saved choices', async () => {
  const dir = await directory(), host = new FakeHost(); hosts.push(host);
  host.values.set('profileContext', { dir }); apply(host);
  const api = host.values.get('flashStabilizer') as StabilizerAPI;
  const choices = [{ provider: 'fixture', model: 'synthetic-model' }];
  await Promise.all([api.setMode('assist'), api.setMode('observe'),
    api.setModelScope({ scope: 'selected', selections: choices }), api.setModelScope({ scope: 'all', selections: choices })]);
  const reloaded = new FakeHost(); hosts.push(reloaded);
  reloaded.values.set('profileContext', { dir }); apply(reloaded);
  const restored = reloaded.values.get('flashStabilizer') as StabilizerAPI;
  expect(restored.status().mode).toBe('observe');
  expect(restored.modelScope()).toMatchObject({ scope: 'all', selections: choices });
});
