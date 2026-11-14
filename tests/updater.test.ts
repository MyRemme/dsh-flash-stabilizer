import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { manifestCandidate, releaseCandidate, Updater, validateArchive } from '../src/updater.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const roots: string[] = [], updaters: Updater[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(async () => { for (const value of updaters.splice(0)) value.dispose(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(changes: Record<string, unknown> = {}, link = false) {
  const directory = await mkdtemp(join(tmpdir(), 'flash-update-')); roots.push(directory);
  const base = join(directory, 'package');
  await mkdir(join(base, 'dist'), { recursive: true }); await mkdir(join(base, 'client'));
  const pkg = { name: 'dsh-flash-stabilizer', version: '0.1.8', engines: { node: '>=22.18.0', dsh: '0.2.1-rc.2' }, ...changes };
  await writeFile(join(base, 'package.json'), JSON.stringify(pkg)); await writeFile(join(base, 'dist/index.js'), 'export const name="test";');
  await writeFile(join(base, 'client/client.js'), '/* fixture */'); await writeFile(join(base, 'cordis.patch.yml'), '[]');
  if (link) { const { symlink } = await import('node:fs/promises'); await symlink(join(base, 'dist'), join(base, 'linked'), 'junction'); }
  const file = join(directory, 'fixture.tgz'); await create({ cwd: directory, file, gzip: true }, ['package']);
  const buffer = await readFile(file), digest = 'sha256:' + createHash('sha256').update(buffer).digest('hex');
  const release = { tag_name: 'v0.1.8', draft: false, prerelease: false, assets: [{ id: 10, name: 'dsh-flash-stabilizer-0.1.8.tgz', size: buffer.length, digest }] };
  return { directory, file, buffer, release };
}
async function setup(options: { busy?: boolean; checksum?: boolean; fail?: boolean; idleProbe?: () => boolean } = {}) {
  const data = await fixture(); let idle = !options.busy;
  if (options.checksum) data.release.assets[0]!.digest = 'sha256:' + '0'.repeat(64);
  const transport = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/latest')
    ? new Response(JSON.stringify(data.release)) : new Response(new Uint8Array(data.buffer)));
  const publicTransport = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
  const installBundle = vi.fn(async (_spec: string) => ({ application: options.fail ? 'failed' : 'restart-required', version: '0.1.8' }));
  const updater = new Updater({ directory: data.directory, hostVersion: '0.2.1-rc.2', manager: { installBundle }, idle: options.idleProbe ?? (() => idle),
    fetch: (url, options) => String(url).endsWith('/stable.json') ? publicTransport(url, options) : transport(url, options), schedule: false, currentVersion: '0.1.7' });
  updaters.push(updater); await updater.start();
  return { ...data, updater, transport, publicTransport, installBundle, idle: (value: boolean) => { idle = value; } };
}
function publicManifest(buffer: Buffer, changes: Record<string, unknown> = {}) {
  return { schemaVersion: 1, version: '0.1.8', name: 'dsh-flash-stabilizer-0.1.8.tgz', size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'), ...changes };
}
it.skipIf(process.platform !== 'win32')('retries transient Windows locks while saving update state atomically', async () => {
  const { updater, directory } = await setup();
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('Destination open'), { code: 'EPERM' }));
  expect((await updater.check()).phase).toBe('available');
  expect(JSON.parse(await readFile(join(directory, '.flash-stabilizer/updates/state.json'), 'utf8')).phase).toBe('available');
});
it('checks and installs from public Release assets without using the REST API quota', async () => {
  const { updater, publicTransport, transport, buffer, installBundle } = await setup();
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer))));
  expect((await updater.check()).phase).toBe('available');
  expect(transport).not.toHaveBeenCalled();
  updater.install(); await settled(updater);
  expect(updater.status()).toMatchObject({ phase: 'restart-required', error: null });
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    'https://github.com/MyRemme/dsh-flash-stabilizer/releases/download/v0.1.8/dsh-flash-stabilizer-0.1.8.tgz',
  ]);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('follows only repository asset and signed-download redirects without credentials', async () => {
  const { updater, publicTransport, transport, buffer } = await setup();
  publicTransport.mockImplementation(async () => new Response(null, { status: 302,
    headers: { location: 'https://github.com/MyRemme/dsh-flash-stabilizer/releases/download/v0.1.8/update.json' } }));
  transport.mockImplementation(async (url, options) => {
    expect(new Headers(options?.headers).has('Authorization')).toBe(false);
    if (String(url).endsWith('/update.json')) return new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/fixture-manifest' } });
    expect(options?.headers).toBeUndefined();
    return new Response(JSON.stringify(publicManifest(buffer)));
  });
  expect((await updater.check()).phase).toBe('available');
  expect(transport).toHaveBeenCalledTimes(2);
});
it.each([403, 429])('recovers from REST HTTP %i via the public manifest and respects REST backoff', async status => {
  const { updater, publicTransport, transport, buffer } = await setup();
  transport.mockImplementation(async () => new Response(null, { status, headers: {
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3600),
  } }));
  expect((await updater.check()).error).toBe('github-denied');
  // Retrying a legacy release must not keep hitting the exhausted API.
  await updater.check(); expect(transport).toHaveBeenCalledTimes(1);
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer))));
  expect(await updater.check()).toMatchObject({ phase: 'available', latestVersion: '0.1.8', error: null });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('coalesces concurrent checks and reuses a recent successful result on repeated clicks', async () => {
  const { updater, publicTransport, transport } = await setup();
  const started = deferred<void>(), result = deferred<Response>();
  transport.mockImplementation(async () => { started.resolve(); return result.promise; });
  const first = updater.check(); await started.promise;
  expect(updater.check()).toBe(first);
  result.resolve(new Response(JSON.stringify({ tag_name: 'v0.1.7', assets: [] })));
  expect(await first).toMatchObject({ phase: 'current', error: null });
  await updater.check(); await updater.check();
  expect(publicTransport).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
});
it.each([
  { schemaVersion: 2 }, { version: '0.1.8-beta.1' }, { name: '../other.tgz' }, { size: 0 },
  { size: 33 * 1024 * 1024 }, { sha256: 'invalid' }, { assetId: -1 },
])('rejects malformed public metadata without bypassing validation: %j', async changes => {
  const { updater, publicTransport, transport, buffer, installBundle } = await setup();
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer, changes))));
  expect((await updater.check()).error).toBe('invalid-release');
  expect(transport).not.toHaveBeenCalled(); expect(installBundle).not.toHaveBeenCalled();
});
it('rejects invalid JSON, foreign redirects and redirect loops in public metadata', async () => {
  const { updater, publicTransport, transport } = await setup();
  publicTransport.mockImplementationOnce(async () => new Response('{'));
  expect((await updater.check()).error).toBe('invalid-release');
  publicTransport.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/update.json' } }));
  expect((await updater.check()).error).toBe('invalid-redirect');
  publicTransport.mockImplementation(async () => new Response(null, { status: 302,
    headers: { location: 'https://github.com/MyRemme/dsh-flash-stabilizer/releases/download/v0.1.8/stable.json' } }));
  expect((await updater.check()).error).toBe('invalid-redirect');
  expect(transport).not.toHaveBeenCalled();
});
it('checks public archive integrity before installation and enforces the metadata size cap', async () => {
  const { updater, publicTransport, transport, buffer, installBundle } = await setup();
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer))));
  await updater.check(); transport.mockImplementation(async () => new Response('corrupted archive'));
  updater.install(); await settled(updater);
  expect(updater.status().error).toBe('checksum-failed'); expect(installBundle).not.toHaveBeenCalled();
  publicTransport.mockImplementation(async () => new Response(' '.repeat(16 * 1024 + 1)));
  expect((await updater.check()).error).toBe('download-too-large');
});
it('recognizes the installed version from a valid public manifest', async () => {
  const { buffer } = await fixture();
  expect(manifestCandidate(publicManifest(buffer), '0.1.8')).toBeNull();
  expect(manifestCandidate(publicManifest(buffer), '0.1.9')).toBeNull();
});
it('checks again after the short cache expires and can enable automatic installation from cached metadata', async () => {
  const { updater, publicTransport, transport, buffer, installBundle } = await setup();
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer, {
    version: '0.1.7', name: 'dsh-flash-stabilizer-0.1.7.tgz',
  }))));
  expect((await updater.check()).phase).toBe('current');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60001);
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer))));
  expect((await updater.check()).phase).toBe('available');
  expect(publicTransport).toHaveBeenCalledTimes(2); expect(transport).not.toHaveBeenCalled();
  await updater.setAutomatic(true); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1); expect(publicTransport).toHaveBeenCalledTimes(2);
});
it('falls back to the API asset when the public download host is unreachable', async () => {
  const { updater, publicTransport, transport, buffer, installBundle } = await setup();
  publicTransport.mockImplementation(async () => new Response(JSON.stringify(publicManifest(buffer, { assetId: 10 }))));
  transport.mockImplementation(async url => {
    if (String(url).startsWith('https://github.com/')) throw new TypeError('Connection timeout');
    return new Response(new Uint8Array(buffer));
  });
  await updater.check(); updater.install(); await settled(updater);
  expect(updater.status().phase).toBe('restart-required'); expect(installBundle).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    'https://github.com/MyRemme/dsh-flash-stabilizer/releases/download/v0.1.8/dsh-flash-stabilizer-0.1.8.tgz',
    'https://api.github.com/repos/MyRemme/dsh-flash-stabilizer/releases/assets/10',
  ]);
});
async function settled(updater: Updater) {
  for (let i = 0; i < 100; i++) {
    if (!['downloading', 'installing'].includes(updater.status().phase)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('updater did not settle');
}
it.each(['late-response', 'abort'])('revokes an automatic download (%s) and allows a later manual install', async outcome => {
  const { updater, transport, buffer, release, installBundle } = await setup();
  const started = deferred<void>(), download = deferred<Response>();
  let signal: AbortSignal | undefined;
  transport.mockImplementation(async (url, options) => {
    if (String(url).endsWith('/latest')) return new Response(JSON.stringify(release));
    signal = options?.signal ?? undefined;
    if (outcome === 'abort') signal?.addEventListener('abort', () => download.reject(signal?.reason), { once: true });
    started.resolve(); return download.promise;
  });
  await updater.setAutomatic(true); await started.promise;
  await updater.setAutomatic(false);
  const aborted = signal?.aborted;
  // A transport may resolve after cancellation; it must not reach the installer.
  download.resolve(new Response(new Uint8Array(buffer))); await settled(updater);
  expect(aborted).toBe(true);
  expect(updater.status()).toMatchObject({ automatic: false, phase: 'available', error: null });
  expect(installBundle).not.toHaveBeenCalled();
  transport.mockImplementation(async () => new Response(new Uint8Array(buffer)));
  updater.install(); await settled(updater); expect(installBundle).toHaveBeenCalledTimes(1);
});
it('does not cancel a manually requested download when automatic updates are disabled', async () => {
  const { updater, transport, buffer, installBundle } = await setup();
  await updater.check();
  const started = deferred<void>(), download = deferred<Response>();
  let signal: AbortSignal | undefined;
  transport.mockImplementationOnce(async (_url, options) => {
    signal = options?.signal ?? undefined; started.resolve(); return download.promise;
  });
  updater.install(); await started.promise; await updater.setAutomatic(false);
  expect(signal?.aborted).toBe(false);
  download.resolve(new Response(new Uint8Array(buffer))); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('retains a manual retry submitted while a cancelled automatic download is still unwinding', async () => {
  const { updater, transport, buffer, release, installBundle } = await setup();
  const started = deferred<void>(), download = deferred<Response>(); let downloads = 0;
  transport.mockImplementation(async url => {
    if (String(url).endsWith('/latest')) return new Response(JSON.stringify(release));
    if (++downloads === 1) { started.resolve(); return download.promise; }
    return new Response(new Uint8Array(buffer));
  });
  await updater.setAutomatic(true); await started.promise;
  await updater.setAutomatic(false); updater.install();
  download.resolve(new Response(new Uint8Array(buffer)));
  await vi.waitFor(() => expect(installBundle).toHaveBeenCalledTimes(1));
  await settled(updater);
  expect(updater.status()).toMatchObject({ automatic: false, phase: 'restart-required' });
});
it('retains a queued manual install when automatic updates are disabled', async () => {
  const { updater, idle, installBundle } = await setup({ busy: true });
  await updater.check(); updater.install(); await updater.setAutomatic(false);
  expect(updater.status().phase).toBe('waiting-idle');
  idle(true); updater.install(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('preserves a queued manual install across automatic on/off and later checks', async () => {
  const { updater, transport, idle, installBundle } = await setup({ busy: true });
  await updater.check(); updater.install();
  await updater.setAutomatic(true); await updater.check(); await updater.setAutomatic(false);
  expect(updater.status()).toMatchObject({ phase: 'waiting-idle', automatic: false });
  expect(transport).toHaveBeenCalledTimes(1);
  idle(true); updater.install(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it.each([2, 3])('persists waiting-idle at idle check %i and reuses the validated archive', async busyAt => {
  let probes = 0, allow = false;
  const { updater, directory, transport, installBundle } = await setup({ idleProbe: () => allow || ++probes < busyAt });
  await updater.check(); updater.install(); await settled(updater);
  expect(updater.status().phase).toBe('waiting-idle'); expect(installBundle).not.toHaveBeenCalled();
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, '.flash-stabilizer/updates/state.json'), 'utf8')).phase).toBe('waiting-idle'));
  allow = true; updater.install(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls.filter(([url]) => String(url).includes('/assets/'))).toHaveLength(1);
});
it('rechecks a cached archive before handing it to the host', async () => {
  let probes = 0, allow = false;
  const { updater, directory, release, transport, installBundle } = await setup({ idleProbe: () => allow || ++probes < 2 });
  await updater.check(); updater.install(); await settled(updater);
  const hash = release.assets[0]!.digest.slice(7);
  await writeFile(join(directory, '.flash-stabilizer/updates', `dsh-flash-stabilizer-0.1.8-${hash.slice(0, 12)}.tgz`), 'changed since validation');
  allow = true; updater.install();
  await vi.waitFor(() => expect(updater.status()).toMatchObject({ phase: 'error', error: 'checksum-failed' }));
  expect(installBundle).not.toHaveBeenCalled();
  expect(transport.mock.calls.filter(([url]) => String(url).includes('/assets/'))).toHaveLength(1);
});
it('revokes a queued automatic install when automatic updates are disabled', async () => {
  const { updater, installBundle } = await setup({ busy: true });
  await updater.setAutomatic(true); await updater.check();
  expect(updater.status().phase).toBe('waiting-idle');
  await updater.setAutomatic(false);
  expect(updater.status()).toMatchObject({ automatic: false, phase: 'available' });
  expect(installBundle).not.toHaveBeenCalled();
});
it('does not revive a cancelled download after automatic updates are enabled again', async () => {
  const { updater, transport, buffer, release, installBundle } = await setup();
  const started = deferred<void>(), download = deferred<Response>();
  transport.mockImplementation(async url => {
    if (String(url).endsWith('/latest')) return new Response(JSON.stringify(release));
    started.resolve(); return download.promise;
  });
  await updater.setAutomatic(true); await started.promise;
  await updater.setAutomatic(false); await updater.setAutomatic(true);
  download.resolve(new Response(new Uint8Array(buffer))); await settled(updater);
  expect(updater.status()).toMatchObject({ automatic: true, phase: 'available' });
  expect(installBundle).not.toHaveBeenCalled();
  transport.mockImplementation(async url => String(url).endsWith('/latest')
    ? new Response(JSON.stringify(release)) : new Response(new Uint8Array(buffer)));
  await updater.check(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('lets an automatic installation already handed to the host finish after disabling', async () => {
  const { updater, installBundle } = await setup();
  const started = deferred<void>(), installed = deferred<{ application: string; version: string }>();
  installBundle.mockImplementationOnce(async () => { started.resolve(); return installed.promise; });
  await updater.setAutomatic(true); await started.promise;
  await updater.setAutomatic(false);
  installed.resolve({ application: 'restart-required', version: '0.1.8' }); await settled(updater);
  expect(updater.status()).toMatchObject({ automatic: false, phase: 'restart-required', error: null });
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('requires a newer formal release with the exact asset and checksum', () => {
  expect(releaseCandidate({ tag_name: 'v0.1.7', assets: [] }, '0.1.7')).toBeNull();
  expect(() => releaseCandidate({ tag_name: 'v0.1.8', assets: [] }, '0.1.7')).toThrow('missing-artifact');
  expect(() => releaseCandidate({ tag_name: 'v0.1.8-beta.1', assets: [] }, '0.1.7')).toThrow('invalid-release');
  expect(() => releaseCandidate({ tag_name: 'v0.1.8', prerelease: true, assets: [] }, '0.1.7')).toThrow('invalid-release');
});
it('validates archive identity, compatibility, dependencies and installation scripts before installing', async () => {
  const good = await fixture(); await validateArchive(good.file, '0.1.8', '0.2.1-rc.2');
  for (const [changes, code] of [[{ name: 'other' }, 'invalid-archive'], [{ scripts: { postinstall: 'do-something' } }, 'install-scripts'],
    [{ dependencies: { unsafe: 'github:example/other' } }, 'invalid-dependencies'], [{ engines: { node: '>=22', dsh: '9.0.0' } }, 'incompatible-host']] as const) {
    const data = await fixture(changes); await expect(validateArchive(data.file, '0.1.8', '0.2.1-rc.2')).rejects.toThrow(code);
  }
  const linked = await fixture({}, true); await expect(validateArchive(linked.file, '0.1.8', '0.2.1-rc.2')).rejects.toThrow('invalid-archive');
});
it('defers installation while a conversation is busy and retains restart-required across reload', async () => {
  const { updater, installBundle, idle, directory } = await setup({ busy: true });
  expect((await updater.check()).phase).toBe('available'); expect(installBundle).not.toHaveBeenCalled();
  expect(updater.install().phase).toBe('waiting-idle'); expect(installBundle).not.toHaveBeenCalled();
  idle(true); updater.install(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1); expect(updater.status().phase).toBe('restart-required');
  expect(installBundle.mock.calls[0]?.[0]).toMatch(/\.tgz$/);
  expect(JSON.stringify(updater.status())).not.toContain('fixture-token');
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(directory, '.flash-stabilizer/updates/state.json'), 'utf8')).phase).toBe('restart-required'));
  const reloaded = new Updater({ directory, hostVersion: '0.2.1-rc.2', manager: { installBundle }, idle: () => true, schedule: false, currentVersion: '0.1.7' });
  updaters.push(reloaded); await reloaded.start(); expect(reloaded.status().phase).toBe('restart-required');
});
it('rejects checksum failure without invoking the host installer', async () => {
  const { updater, installBundle } = await setup({ checksum: true }); await updater.check(); updater.install(); await settled(updater);
  expect(updater.status()).toMatchObject({ phase: 'error', error: 'checksum-failed', currentVersion: '0.1.7' }); expect(installBundle).not.toHaveBeenCalled();
});
it('reports a host refusal without claiming that the new version is active', async () => {
  const { updater } = await setup({ fail: true }); await updater.check(); updater.install(); await settled(updater);
  expect(updater.status()).toMatchObject({ phase: 'error', error: 'host-install-failed', currentVersion: '0.1.7' });
});
it('checks idle again after the download before changing the installation', async () => {
  const { updater, idle, transport, buffer, installBundle } = await setup(); await updater.check();
  transport.mockImplementationOnce(async () => { idle(false); return new Response(new Uint8Array(buffer)); });
  updater.install(); await settled(updater); expect(updater.status().phase).toBe('waiting-idle'); expect(installBundle).not.toHaveBeenCalled();
});
it('uses anonymous requests even when GitHub tokens are configured, including signed asset redirects', async () => {
  vi.stubEnv('DSH_FLASH_STABILIZER_GITHUB_TOKEN', 'fixture-token');
  vi.stubEnv('GH_TOKEN', 'fixture-token');
  vi.stubEnv('GITHUB_TOKEN', 'fixture-token');
  try {
    const { updater, transport, buffer } = await setup(); await updater.check();
    transport.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } }));
    transport.mockImplementationOnce(async (_url, options) => { expect(options?.headers).toBeUndefined(); return new Response(new Uint8Array(buffer)); });
    updater.install(); await settled(updater); expect(updater.status().phase).toBe('restart-required');
    for (const [, options] of transport.mock.calls) expect(new Headers(options?.headers).has('Authorization')).toBe(false);
  } finally { vi.unstubAllEnvs(); }
});
it('rejects redirects outside GitHub and does not expose upstream errors', async () => {
  const { updater, transport, installBundle } = await setup(); await updater.check();
  transport.mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/fixture' } }));
  updater.install(); await settled(updater); expect(updater.status().error).toBe('invalid-redirect'); expect(installBundle).not.toHaveBeenCalled();
  transport.mockRejectedValueOnce(Error('private URL and credential'));
  await updater.check(); expect(JSON.stringify(updater.status())).not.toContain('private URL');
});
it('persists the automatic switch and installs only after opting in', async () => {
  const { updater, directory, installBundle } = await setup();
  expect(updater.status().automatic).toBe(false);
  await updater.setAutomatic(true); await updater.check(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(join(directory, '.flash-stabilizer/updates/state.json'), 'utf8'));
  expect(saved.automatic).toBe(true); expect(JSON.stringify(saved)).not.toContain('fixture-token');
  await updater.setAutomatic(false); expect(updater.status().automatic).toBe(false);
});
it('pins the manual candidate without a network recheck that could discard the user request', async () => {
  const { updater, transport, idle, installBundle, buffer } = await setup({ busy: true });
  await updater.check(); updater.install();
  transport.mockRejectedValueOnce(Error('offline'));
  await updater.check();
  expect(transport).toHaveBeenCalledTimes(1); expect(updater.status().phase).toBe('waiting-idle');
  transport.mockReset().mockImplementation(async () => new Response(new Uint8Array(buffer)));
  // The existing fixture remains the chosen release; another check cannot replace it.
  idle(true); updater.install(); await settled(updater);
  expect(installBundle).toHaveBeenCalledTimes(1);
});
it('schedules checks every six hours only when automatic updates are enabled', async () => {
  const { directory, transport, publicTransport, installBundle } = await setup({ busy: true });
  const updater = new Updater({ directory, hostVersion: '0.2.1-rc.2', currentVersion: '0.1.7',
    fetch: (url, options) => String(url).endsWith('/stable.json') ? publicTransport(url, options) : transport(url, options),
    manager: { installBundle }, idle: () => false });
  updaters.push(updater); vi.useFakeTimers(); await updater.start();
  await vi.advanceTimersByTimeAsync(30000); expect(transport).not.toHaveBeenCalled();
  await updater.setAutomatic(true); await updater.check(); const count = transport.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 15000); expect(transport).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(15000); expect(transport).toHaveBeenCalledTimes(count + 1);
  await updater.setAutomatic(false); await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(transport).toHaveBeenCalledTimes(count + 1);
});
