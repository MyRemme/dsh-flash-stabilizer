import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { valid, gt, satisfies } from 'semver';
import { list } from 'tar';
import { gunzipSync } from 'node:zlib';
import { finished } from 'node:stream/promises';
import type { HostContext } from './types.js';

export const REPOSITORY = 'https://github.com/MyRemme/dsh-flash-stabilizer';
const API = 'https://api.github.com/repos/MyRemme/dsh-flash-stabilizer';
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const MAX_ARCHIVE = 32 * 1024 * 1024;
const INTERVAL = 6 * 60 * 60 * 1000;
export interface UpdateStatus {
  repository: string; currentVersion: string; available: boolean; automatic: boolean;
  phase: 'unavailable' | 'idle' | 'checking' | 'current' | 'available' | 'waiting-idle' | 'downloading' | 'installing' | 'restart-required' | 'error';
  latestVersion: string | null; checkedAt: string | null; updatedAt: string | null;
  error: string | null;
}
export interface UpdateAPI {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  setAutomatic(enabled: boolean): Promise<UpdateStatus>;
  install(): UpdateStatus;
}
export interface Manager {
  installBundle(spec: string, options?: { enabled?: boolean; requestId?: string }): Promise<{ application: string; version?: string }>;
}
interface Asset { id: number; name: string; size: number; digest?: string }
interface Candidate { version: string; asset: Asset; checksum: Asset | undefined }
class UpdateFailure extends Error {}
const failure = (code: string): never => { throw new UpdateFailure(code); };

export function releaseCandidate(value: unknown, current: string): Candidate | null {
  const release = value as { draft?: boolean; prerelease?: boolean; tag_name?: string; assets?: Asset[] };
  if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return failure('invalid-release');
  const version = release.tag_name.replace(/^v/, '');
  if (!valid(version) || version.includes('-')) return failure('invalid-release');
  if (!gt(version, current)) return null;
  const asset = release.assets.find(asset => asset.name === `${manifest.name}-${version}.tgz`);
  const checksum = release.assets.find(asset => asset.name === 'checksums.sha256');
  for (const item of [asset, checksum].filter(Boolean) as Asset[]) {
    if (!Number.isSafeInteger(item.id) || item.id <= 0 || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > MAX_ARCHIVE) return failure('invalid-release');
  }
  if (!asset || (!/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '') && !checksum)) return failure('missing-artifact');
  return { version, asset, checksum };
}

/** Inspect every entry before pnpm sees it; no links, traversal or install scripts. */
export async function validateArchive(file: string, version: string, hostVersion: string): Promise<void> {
  const names = new Set<string>();
  let entries = 0, bytes = 0, invalid = false;
  const body: Buffer[] = [];
  const uncompressed = gunzipSync(await readFile(file), { maxOutputLength: 64 * 1024 * 1024 });
  const parser = list({ strict: true, onReadEntry: entry => {
    bytes += entry.size;
    if (++entries > 3000 || bytes > 64 * 1024 * 1024 || !entry.path.startsWith('package/') || entry.path.includes('\\')
      || entry.path.split('/').some(part => part === '..' || part === '.') || names.has(entry.path)
      || !['File', 'Directory'].includes(entry.type)) invalid = true;
    names.add(entry.path);
    if (entry.size > 4 * 1024 * 1024) invalid = true;
    if (entry.path === 'package/package.json' && entry.size <= 256 * 1024) entry.on('data', part => { body.push(Buffer.from(part)); });
  } });
  const done = finished(parser); parser.end(uncompressed); await done;
  if (invalid || !names.has('package/dist/index.js') || !names.has('package/client/client.js') || !names.has('package/cordis.patch.yml')) return failure('invalid-archive');
  const pkg = JSON.parse(Buffer.concat(body).toString()) as { name: string; version: string; scripts?: Record<string, unknown>; engines?: { node?: string; dsh?: string }; dependencies?: Record<string, string> };
  if (pkg.name !== manifest.name || pkg.version !== version) return failure('invalid-archive');
  if (['preinstall', 'install', 'postinstall', 'prepare'].some(key => pkg.scripts?.[key])) return failure('install-scripts');
  if (Object.values(pkg.dependencies ?? {}).some(value => !valid(value))) return failure('invalid-dependencies');
  if (!valid(hostVersion) || !pkg.engines?.dsh || !satisfies(hostVersion, pkg.engines.dsh)
    || !pkg.engines.node || !satisfies(process.versions.node, pkg.engines.node)) return failure('incompatible-host');
}

export class Updater implements UpdateAPI {
  private state: UpdateStatus;
  private candidate: Candidate | null = null;
  private pending = false;
  private work: Promise<UpdateStatus> | null = null;
  private installing = false;
  private disposed = false;
  private abort = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private directory: string;
  private saving: Promise<void> = Promise.resolve();
  private nextCheck = Date.now();
  constructor(private readonly options: {
    directory: string; hostVersion: string; manager: Manager; idle: () => boolean;
    fetch?: typeof fetch;
    currentVersion?: string; schedule?: boolean;
  }) {
    this.directory = join(options.directory, '.flash-stabilizer', 'updates');
    this.state = { repository: REPOSITORY, currentVersion: options.currentVersion ?? manifest.version, available: true, automatic: false,
      phase: 'idle', latestVersion: null, checkedAt: null, updatedAt: null, error: null };
  }
  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8')) as Partial<UpdateStatus>;
      this.state.automatic = saved.automatic === true;
      this.state.updatedAt = typeof saved.updatedAt === 'string' ? saved.updatedAt : null;
      if (saved.phase === 'restart-required' && saved.latestVersion && valid(saved.latestVersion) && gt(saved.latestVersion, this.state.currentVersion)) {
        this.state.phase = 'restart-required'; this.state.latestVersion = saved.latestVersion;
      }
    } catch { /* First installation or invalid state starts with automatic updates off. */ }
    if (this.disposed || this.options.schedule === false) return;
    this.timer = setInterval(() => {
      if (this.pending && this.options.idle()) this.install();
      else if (this.state.automatic && this.state.phase !== 'restart-required' && Date.now() >= this.nextCheck && !this.work && !this.installing) {
        void this.check();
      }
    }, 15000);
    this.timer.unref();
  }
  status(): UpdateStatus { return { ...this.state }; }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, join(this.directory, 'state.json'));
    });
    return this.saving;
  }
  async setAutomatic(enabled: boolean): Promise<UpdateStatus> {
    this.state.automatic = enabled;
    if (!enabled) this.pending = false;
    if (!enabled && this.state.phase === 'waiting-idle') this.state.phase = 'available';
    try { await this.save(); } catch { this.state.automatic = false; this.state.phase = 'error'; this.state.error = 'storage-failed'; }
    if (enabled && this.state.automatic) void this.check();
    return this.status();
  }
  private async request(path: string, limit: number, binary = false): Promise<Buffer> {
    const transport = this.options.fetch ?? fetch;
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]);
    const response = await transport(API + path, { redirect: 'manual', signal, headers: {
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': manifest.name,
      'X-GitHub-Api-Version': '2022-11-28',
    } });
    let result = response;
    if (binary && [301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location') ?? '');
      if (target.protocol !== 'https:' || target.port || target.username || target.password || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(target.hostname)) return failure('invalid-redirect');
      // Signed GitHub asset redirects also use anonymous requests.
      await response.body?.cancel();
      result = await transport(target, { redirect: 'error', signal });
    }
    if ([401, 403, 404].includes(result.status)) { await result.body?.cancel(); return failure(result.status === 403 ? 'github-denied' : 'github-auth-or-release'); }
    if (!result.ok || !result.body) { await result.body?.cancel(); return failure('github-network'); }
    const parts: Buffer[] = []; let size = 0;
    const reader = result.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > limit) return failure('download-too-large');
        parts.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(parts);
  }
  check(): Promise<UpdateStatus> {
    if (this.work) return this.work;
    if (this.disposed || this.installing || this.state.phase === 'restart-required') return Promise.resolve(this.status());
    this.work = (async () => {
      this.nextCheck = Date.now() + INTERVAL;
      this.pending = false; this.candidate = null;
      this.state.phase = 'checking'; this.state.error = null;
      try {
        const body = await this.request('/releases/latest', 1024 * 1024);
        this.candidate = releaseCandidate(JSON.parse(body.toString()), this.state.currentVersion);
        this.state.checkedAt = new Date().toISOString();
        this.state.latestVersion = this.candidate?.version ?? this.state.currentVersion;
        this.state.phase = this.candidate ? 'available' : 'current';
        if (this.state.automatic && this.candidate) this.pending = true;
        await this.save();
      } catch (error) { if (!this.disposed) { this.state.phase = 'error'; this.state.error = error instanceof UpdateFailure ? error.message : 'update-check-failed'; } }
      return this.status();
    })().finally(() => { this.work = null; if (this.pending && !this.disposed) this.install(); });
    return this.work;
  }
  install(): UpdateStatus {
    if (this.disposed || this.installing || this.work || !this.candidate || this.state.phase === 'restart-required') return this.status();
    if (!this.options.idle()) { this.pending = true; this.state.phase = 'waiting-idle'; return this.status(); }
    const candidate = this.candidate;
    this.pending = false; this.installing = true; this.state.phase = 'downloading'; this.state.error = null;
    // Start outside the owner RPC/HMR call; replacing this plugin disposes its old scope.
    setTimeout(() => { if (!this.disposed) void this.performInstall(candidate).finally(() => { this.installing = false; }); }, 0).unref();
    return this.status();
  }
  private async performInstall(candidate: Candidate): Promise<void> {
    try {
      const archive = await this.request(`/releases/assets/${candidate.asset.id}`, MAX_ARCHIVE, true);
      let hash = candidate.asset.digest?.match(/^sha256:([a-f\d]{64})$/i)?.[1]?.toLowerCase();
      if (!hash && candidate.checksum) {
        const sums = (await this.request(`/releases/assets/${candidate.checksum.id}`, 64 * 1024, true)).toString();
        hash = sums.split(/\r?\n/).map(line => /^([a-f\d]{64})\s+\*?(\S+)$/.exec(line)).find(match => match?.[2] === candidate.asset.name)?.[1];
      }
      if (!hash || createHash('sha256').update(archive).digest('hex') !== hash) return failure('checksum-failed');
      if (archive.length !== candidate.asset.size) return failure('size-mismatch');
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, `${manifest.name}-${candidate.version}-${hash.slice(0, 12)}.tgz`);
      await writeFile(file, archive, { mode: 0o600 });
      await validateArchive(file, candidate.version, this.options.hostVersion);
      if (this.disposed) return;
      if (!this.options.idle()) { this.pending = true; this.state.phase = 'waiting-idle'; return; }
      this.state.phase = 'installing'; await this.save();
      const result = await this.options.manager.installBundle(file, { enabled: true, requestId: `${manifest.name}-${randomUUID()}` });
      if (!['applied', 'restart-required'].includes(result.application) || result.version !== candidate.version) return failure('host-install-failed');
      this.state.phase = result.application === 'restart-required' ? 'restart-required' : 'current';
      if (result.application === 'applied') this.state.currentVersion = candidate.version;
      this.state.updatedAt = new Date().toISOString(); this.state.error = null;
      await this.save();
    } catch (error) {
      this.state.phase = 'error'; this.state.error = error instanceof UpdateFailure ? error.message : 'update-install-failed';
      await this.save().catch(() => {});
    }
  }
  dispose(): void { this.disposed = true; this.pending = false; clearInterval(this.timer); this.abort.abort(); }
}

export function registerUpdater(ctx: HostContext, hostVersion: string, idle: () => boolean): UpdateAPI {
  let updater: Updater | undefined;
  const unavailable = (): UpdateStatus => ({ repository: REPOSITORY, currentVersion: manifest.version, available: false, automatic: false,
    phase: 'unavailable', latestVersion: null, checkedAt: null, updatedAt: null, error: null });
  ctx.inject?.(['pluginManager', 'profileContext'], child => {
    const manager = child.get?.('pluginManager') as Manager | undefined;
    const profile = child.get?.('profileContext') as { dir?: string } | undefined;
    if (!manager?.installBundle || !profile?.dir) return;
    const hmr = child.get?.('hmr') as { executing?: { exit<T>(callback: () => T): T } } | undefined;
    const own = new Updater({ directory: profile.dir, hostVersion, manager: {
      installBundle: (spec, options) => hmr?.executing ? hmr.executing.exit(() => manager.installBundle(spec, options)) : manager.installBundle(spec, options),
    }, idle });
    updater = own;
    void own.start();
    child.effect(() => () => { own.dispose(); if (updater === own) updater = undefined; });
  });
  return { status: () => updater?.status() ?? unavailable(), check: () => updater?.check() ?? Promise.resolve(unavailable()),
    setAutomatic: enabled => updater?.setAutomatic(enabled) ?? Promise.resolve(unavailable()), install: () => updater?.install() ?? unavailable() };
}
