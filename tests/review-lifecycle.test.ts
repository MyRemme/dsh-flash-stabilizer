import { afterEach, expect, it, vi } from 'vitest';
import { apply, type StabilizerAPI } from '../src/index.js';
import { FakeHost, chunks, makeAgent, repeated, stream } from './helpers.js';
import type { Chunk } from '../src/types.js';

const hosts: FakeHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); });
function setup(mode: 'observe' | 'assist' | 'guard' = 'observe') {
  const host = new FakeHost(); hosts.push(host); apply(host, { hostVersion: '0.2.2-rc.1', mode });
  return { host, api: host.values.get('flashStabilizer') as StabilizerAPI };
}
it.each(['tools/result', 'session/event', 'agent/status', 'agent/pre-step'])('attributes %s failures to the session and step without exposing private errors', async hook => {
  const { host, api } = setup(), agent = makeAgent('private-session');
  await stream(host, agent, chunks('normal answer'), true);
  const fail = (): never => { throw new TypeError('private route and contents'); };
  if (hook === 'tools/result') host.emit(hook, { agent, name: 'read', arguments: {} }, { isError: false, get content() { return fail(); } });
  if (hook === 'session/event') host.emit(hook, { id: agent.id }, { type: 'turn/end', get data() { return fail(); } });
  if (hook === 'agent/status') {
    host.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { get reason() { return fail(); } } });
    host.emit(hook, { agent, status: 'idle' });
  }
  if (hook === 'agent/pre-step') await host.waterfall(hook, [{ agent, signal: new AbortController().signal, turn: 1, step: 1, get messages() { return fail(); } }], async () => {});
  expect(api.sessionStatus(agent.id).latestEvent).toMatchObject({ kind: 'internal-error', action: 'type-error', turn: 1, step: 1 });
  expect(api.sessionStatus(agent.id).live?.incompleteReason).toBe('monitor-error');
  expect(JSON.stringify([api.status(), host.warnings])).not.toMatch(/private-session|private route|contents/);
});
it('does not report large normal tool results as an internal error or bridge them into a repeat', async () => {
  const { host, api } = setup(), agent = makeAgent();
  await stream(host, agent, chunks('normal answer'), true);
  const exec = { agent, name: 'read', arguments: {} }, normal = { isError: false, content: 'unchanged' };
  for (let i = 0; i < 3; i++) host.emit('tools/result', exec, normal);
  host.emit('tools/result', exec, { isError: false, value: Array.from({ length: 21000 }, (_, i) => i) });
  host.emit('tools/result', exec, normal);
  expect(api.status().counts['internal-error'] ?? 0).toBe(0);
  expect(api.sessionStatus(agent.id)).toMatchObject({ toolResults: 5, toolWarnings: 0 });
});
it.each([true, false])('does not attach old attempt frames to a subsequent request (new step: %s)', async newStep => {
  const { host, api } = setup(), agent = makeAgent(); let signal = new AbortController().signal;
  const prepare = async () => host.waterfall('agent/pre-step', [{ agent, signal, turn: 1, step: newStep ? 2 : 1, messages: [] }], async () => {});
  const frame = (type: string, attemptId: string, chunk?: Chunk) => host.emit('agent/assistant-stream', { agent, frame: { type, attemptId, chunk } });
  const create = () => host.waterfall('llm/stream', [{ sessionId: agent.id, signal, model: 'deepseek-flash', provider: 'mock' }], async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'normal' };
  })[Symbol.asyncIterator]();
  await prepare(); frame('start', 'old');
  const old = create(); await old.next(); await old.next();
  if (newStep) { signal = new AbortController().signal; await prepare(); }
  const current = create(); await current.next();
  try {
    frame('chunk', 'old', { type: 'reasoning-delta', index: 0, text: repeated });
    expect(api.sessionStatus(agent.id).live?.reasoningChars).toBe(0);
    expect(api.sessionStatus(agent.id).confirmed).toBe(0);
    frame('start', 'current'); frame('chunk', 'current', { type: 'reasoning-delta', index: 0, text: repeated });
    expect(api.sessionStatus(agent.id).confirmed).toBe(1);
  } finally { await current.return(); }
});
it.each(['observe', 'assist', 'guard'] as const)('records only eligible confirmed output as awaiting intervention in %s', async mode => {
  const { host, api } = setup(mode);
  expect(api.status().mode).toBe(mode);
  for (const type of ['reasoning', 'text']) {
    const agent = { ...makeAgent(type), cancel: vi.fn(), followup: vi.fn() };
    await stream(host, agent, chunks(repeated, 73, type), true);
    const events = api.sessionStatus(agent.id).events.filter(event => event.kind === 'stream-repeat');
    expect(events.some(event => !event.confirmed)).toBe(true);
    expect(events.filter(event => !event.confirmed).every(event => event.action === 'observe-only')).toBe(true);
    expect(events.find(event => event.confirmed)?.action).toBe(mode === 'assist' || mode === 'guard' && type === 'reasoning' ? 'awaiting-recovery-decision' : 'observe-only');
  }
});
