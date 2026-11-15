import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationSafety, assessCommand } from '../src/operation-safety.js';
import { apply, type StabilizerAPI } from '../src/index.js';
import type { PreToolDecision, ToolExecution } from '../src/types.js';
import { FakeHost, makeAgent } from './helpers.js';

const hosts: FakeHost[] = [], directories: string[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'flash-safety-')); directories.push(dir); return dir; }
function fixture(options: { enabled?: boolean; version?: string; profile?: string; guard?: boolean } = {}) {
  const host = new FakeHost(); hosts.push(host);
  const guards: ((exec: ToolExecution) => string | undefined)[] = [];
  if (options.guard !== false) host.values.set('tools', { guard(check: (exec: ToolExecution) => string | undefined) {
    guards.push(check); return () => { const at = guards.indexOf(check); if (at >= 0) guards.splice(at, 1); };
  } });
  let mode = 'workspace-write', outcome: unknown = 'rejected';
  const requests: any[] = [];
  const approval = { request: vi.fn(async (request: unknown) => { requests.push(request); return outcome; }) };
  const policy = { resolve: vi.fn(() => ({ mode, workspaceRoot: 'D:\\project' })) };
  host.values.set('approval', approval); host.values.set('sandboxPolicy', policy);
  const safety = new OperationSafety(host, options.enabled ?? true, options.version ?? '0.2.2-rc.1', options.profile);
  const agent = makeAgent('private-safety-session');
  let bodies = 0, sequence = 0;
  const execution = (command: string, name = 'pwsh', args: unknown = { command, workdir: 'D:\\project' }): ToolExecution =>
    Object.freeze({ name, arguments: args, callId: `call-${++sequence}`, agent, signal: new AbortController().signal });
  const run = async (exec: ToolExecution) => {
    const gate: PreToolDecision = await host.waterfall('tools/pre-execute', [exec], () => Promise.resolve({ kind: 'allow' }));
    if (gate.kind !== 'allow') return gate;
    for (const guard of guards) { const reason = guard(exec); if (reason) return { kind: 'deny', reason }; }
    bodies++; return { kind: 'executed' };
  };
  return { host, safety, agent, guards, approval, requests, policy, execution, run, bodies: () => bodies,
    setMode: (value: string) => { mode = value; }, setOutcome: (value: unknown) => { outcome = value; } };
}

it.each([
  "Start-Process -FilePath cmd.exe -Verb RunAs -ArgumentList '/c echo harmless-fixture'",
  "$inner = 'echo harmless-fixture'; Start-Process cmd.exe -v 'RunAs' -ArgumentList $inner",
  'Sta`rt-Process cmd.exe -Verb RunAs', 'runas.exe /user:Administrator cmd.exe',
  'schtasks /create /tn fixture /tr harmless.exe', 'sc.exe config fixture binpath= harmless.exe',
])('blocks recorded elevation routes before the tool body: %s', async command => {
  const f = fixture(); expect((await f.run(f.execution(command))).kind).toBe('deny');
  expect(f.bodies()).toBe(0); expect(f.requests).toHaveLength(0); expect(f.safety.status().events[0]?.rule).toBe('elevation');
});
it('keeps readonly writes blocked even when the model requests full access or another pre-hook forces allow', async () => {
  const f = fixture(); f.setMode('read-only');
  for (const exec of [f.execution('cmd /c del /f /a D:\\fixture.txt'),
    f.execution('', 'write', { path: 'D:\\fixture.txt', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'model claims authorization' })]) {
    expect((await f.run(exec)).kind).toBe('deny');
  }
  f.host.hooks.set('tools/pre-execute', [async () => ({ kind: 'allow' })]);
  expect((await f.run(f.execution('Remove-Item D:\\fixture.txt'))).kind).toBe('deny');
  expect(f.bodies()).toBe(0);
});
it('admits simple reads, blocks indirection in readonly, and delegates unrelated tools', async () => {
  const f = fixture(); f.setMode('read-only');
  expect((await f.run(f.execution('Get-ChildItem -LiteralPath D:\\project'))).kind).toBe('executed');
  for (const command of ['Get-Content $path', 'Get-Content file; node script.js', 'Get-Content file | Invoke-Expression', 'python inspect.py']) {
    expect((await f.run(f.execution(command))).kind).toBe('deny');
  }
  expect((await f.run(f.execution('', 'read', { path: 'D:\\project\\file' }))).kind).toBe('executed');
  expect(f.bodies()).toBe(2);
});
it('binds an approval to the complete call and asks again for the next call', async () => {
  const f = fixture(); const command = 'Remove-Item -LiteralPath D:\\project\\fixture.txt';
  expect((await f.run(f.execution(command))).kind).toBe('deny'); expect(f.bodies()).toBe(0);
  f.setOutcome('allowed-once');
  expect((await f.run(f.execution(command))).kind).toBe('executed');
  f.setOutcome('rejected');
  expect((await f.run(f.execution(command))).kind).toBe('deny');
  expect(f.requests).toHaveLength(3); expect(f.bodies()).toBe(1);
  expect(f.requests[1]).toMatchObject({ agent: f.agent, callId: 'call-2', toolName: 'pwsh' });
  expect(f.requests[1].reason).toContain(JSON.stringify(command)); expect(f.requests[1].reason).toContain('workdir');
  const exported = JSON.stringify(f.safety.status());
  expect(exported).not.toContain('fixture.txt'); expect(exported).not.toContain('private-safety-session');
});
it('does not let another pre-hook skip required approval, and preserves downstream denial', async () => {
  const f = fixture();
  f.host.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'other policy' }));
  f.setOutcome('allowed-once');
  expect(await f.run(f.execution('Remove-Item fixture'))).toEqual({ kind: 'deny', reason: 'other policy' });
  f.host.hooks.set('tools/pre-execute', [async () => ({ kind: 'allow' })]);
  expect((await f.run(f.execution('Remove-Item fixture'))).kind).toBe('deny'); expect(f.bodies()).toBe(0);
});
it('keeps simultaneous approvals isolated by call and agent', async () => {
  const f = fixture();
  const first = f.execution('Remove-Item first-fixture'), second = { ...f.execution('Remove-Item second-fixture'), agent: makeAgent('second-private-session') };
  let allow!: (value: unknown) => void, reject!: (value: unknown) => void;
  const accepted = new Promise<unknown>(resolve => { allow = resolve; }), rejected = new Promise<unknown>(resolve => { reject = resolve; });
  f.approval.request.mockImplementation(async (request: any) => request.callId === first.callId ? accepted : rejected);
  const a = f.run(first), b = f.run(second); await Promise.resolve();
  reject('rejected'); expect((await b).kind).toBe('deny'); expect(f.bodies()).toBe(0);
  allow('allowed-once'); expect((await a).kind).toBe('executed'); expect(f.bodies()).toBe(1);
  expect(f.safety.status()).toMatchObject({ approvalRequests: 2, approved: 1, denied: 1 });
});
it('rechecks the approved arguments and policy at final dispatch', async () => {
  const f = fixture(); f.setOutcome('allowed-once');
  const args = { command: 'Remove-Item first-fixture' }, exec = f.execution('', 'pwsh', args);
  f.host.on('tools/pre-execute', async (_exec, next) => { args.command = 'Remove-Item changed-fixture'; return next(); });
  expect((await f.run(exec)).kind).toBe('deny'); expect(f.bodies()).toBe(0);
});
it.each(['unavailable', 'cancelled', 'allowed', undefined])('rejects a non-grant approval outcome: %s', async outcome => {
  const f = fixture(); f.setOutcome(outcome);
  expect((await f.run(f.execution('node script.js'))).kind).toBe('deny'); expect(f.bodies()).toBe(0);
});
it('fails closed on malformed arguments, missing policy/approval and thrown checks', async () => {
  const f = fixture();
  for (const args of [null, [], { command: 3 }, { command: 'Get-Location', script: 'other' }]) {
    expect((await f.run(f.execution('', 'pwsh', args))).kind).toBe('deny');
  }
  f.host.values.delete('approval'); expect((await f.run(f.execution('node script.js'))).kind).toBe('deny');
  f.policy.resolve.mockImplementation(() => { throw Error('policy failed'); });
  expect((await f.run(f.execution('Get-Location'))).kind).toBe('deny');
  f.host.values.delete('sandboxPolicy'); expect(f.safety.status().state).toBe('blocked');
  expect((await f.run(f.execution('Get-Location'))).kind).toBe('deny'); expect(f.bodies()).toBe(0);
});
it.each([{ version: '9.9.9' }, { guard: false }])('reports unsupported protection and blocks covered calls when enabled: %j', async options => {
  const f = fixture(options); expect(f.safety.status().state).toBe('blocked');
  expect((await f.run(f.execution('Get-Location'))).kind).toBe('deny');
  await f.safety.setEnabled(false); expect((await f.run(f.execution('Get-Location'))).kind).toBe('executed');
});
it('revokes pending approval after policy changes, configuration changes or cancellation', async () => {
  for (const change of ['policy', 'configuration', 'cancel']) {
    const f = fixture(), exec = f.execution('Remove-Item fixture');
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>(done => { resolve = done; });
    f.approval.request.mockImplementationOnce(async () => pending);
    const running = f.run(exec); await Promise.resolve();
    if (change === 'policy') f.setMode('read-only');
    if (change === 'configuration') { await f.safety.setEnabled(false); await f.safety.setEnabled(true); }
    if (change === 'cancel') await f.safety.close();
    resolve('allowed-once'); expect((await running).kind).toBe('deny'); expect(f.bodies()).toBe(0);
  }
});
it('is independent from monitoring, per-session pauses and model selection', async () => {
  const f = fixture({ enabled: false }); await f.safety.close();
  f.host.hooks.delete('tools/pre-execute');
  apply(f.host, { operationSafety: true, modelScope: 'selected', modelSelections: [] });
  const api = f.host.values.get('flashStabilizer') as StabilizerAPI;
  api.setMonitoring(false); api.setSessionEnabled(f.agent.id, false);
  expect(api.operationSafety().enabled).toBe(true);
  expect((await f.run(f.execution('Start-Process cmd.exe -Verb RunAs'))).kind).toBe('deny'); expect(f.bodies()).toBe(0);
});
it('persists independent settings, retains them after write failure, and blocks corrupted settings', async () => {
  const profile = await directory(), f = fixture({ profile, enabled: false });
  await f.safety.setEnabled(true);
  expect(JSON.parse(await readFile(join(profile, '.flash-stabilizer/operation-safety.json'), 'utf8'))).toEqual({ enabled: true });
  const reloaded = fixture({ profile, enabled: false }); expect(reloaded.safety.status().enabled).toBe(true);
  await writeFile(join(profile, '.flash-stabilizer/operation-safety.json'), '{broken');
  const corrupted = fixture({ profile, enabled: false }); expect(corrupted.safety.status()).toMatchObject({ enabled: true, state: 'blocked', reason: 'settings-invalid' });
  expect((await corrupted.run(corrupted.execution('Get-Location'))).kind).toBe('deny');
  await corrupted.safety.setEnabled(false); expect(corrupted.safety.status().state).toBe('disabled');
  const badProfile = await directory(); await writeFile(join(badProfile, '.flash-stabilizer'), 'not a directory');
  const failed = fixture({ profile: badProfile, enabled: false });
  const before = failed.safety.status().enabled;
  await expect(failed.safety.setEnabled(!before)).rejects.toThrow(); expect(failed.safety.status().enabled).toBe(before);
});
it('unregisters hard guards on disposal and bounds redacted history', async () => {
  const f = fixture(); for (let n = 0; n < 120; n++) await f.run(f.execution('runas fixture'));
  expect(f.safety.status().events).toHaveLength(100); await f.safety.close(); expect(f.guards).toHaveLength(0);
});
it('keeps ordinary project edits unprompted and flags encoded or nested execution', () => {
  expect(assessCommand('Set-Content -LiteralPath notes.txt -Value updated', 'workspace-write')).toEqual({ kind: 'allow' });
  for (const command of ['pwsh -EncodedCommand Zml4dHVyZQ==', 'cmd /c echo fixture', 'Invoke-Expression $payload', '& $executable', 'echo `custom-command`', 'echo >(custom-command)', 'Get-CustomFunction']) {
    expect(assessCommand(command, 'workspace-write').kind).toBe('ask');
  }
});
it('asks before patch deletion and unknown executable paths while allowing ordinary structured edits', async () => {
  const f = fixture();
  expect((await f.run(f.execution('', 'apply_patch', { patch: '*** Begin Patch\n*** Delete File: fixture.txt\n*** End Patch' }))).kind).toBe('deny');
  expect((await f.run(f.execution('C:\\tools\\custom.exe --task fixture'))).kind).toBe('deny');
  expect((await f.run(f.execution('', 'edit', { path: 'fixture.txt', old_string: 'a', new_string: 'b' }))).kind).toBe('executed');
  expect(f.requests).toHaveLength(2); expect(f.bodies()).toBe(1);
});
