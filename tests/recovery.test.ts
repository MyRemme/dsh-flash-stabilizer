import { describe, expect, it, vi } from 'vitest';
import { defaults } from '../src/config.js';
import { RecoveryController } from '../src/recovery.js';
import { makeAgent } from './helpers.js';
const ending = { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-flash-stabilizer: confirmed repetition' } } };
describe('bounded recovery', () => {
  it.each(['nextStep', 'nextTurn'] as const)('preserves queued %s input without cancelling it', target => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() }, actions: string[] = [];
    const c = new RecoveryController({ ...defaults, mode: 'guard' }, action => actions.push(action));
    c.resetByUser(agent);
    agent.inbox![target] = [{ source: { kind: 'user' } }];
    c.request(agent, new AbortController().signal, true);
    expect(actions).toEqual(['user-input-takes-priority']);
    expect(agent.cancel).not.toHaveBeenCalled(); expect(agent.followup).not.toHaveBeenCalled();
    expect(agent.inbox![target]).toHaveLength(1);
  });
  it('guard requests a stop, confirms durable settlement, and never follows up', async () => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() }, actions: string[] = [];
    const c = new RecoveryController({ ...defaults, mode: 'guard' }, action => actions.push(action));
    c.request(agent, new AbortController().signal, true);
    expect(actions).toEqual(['cancel-requested']);
    c.settled(agent, ending); await Promise.resolve();
    expect(actions).toEqual(['cancel-requested', 'stop-confirmed']);
    expect(agent.cancel).toHaveBeenCalledTimes(1); expect(agent.followup).not.toHaveBeenCalled();
  });
  it('guard cannot cancel unverified hosts or already aborted requests', () => {
    const agent = { ...makeAgent(), cancel: vi.fn() }, c = new RecoveryController({ ...defaults, mode: 'guard' }, () => {});
    c.request(agent, new AbortController().signal, false);
    c.request(agent, AbortSignal.abort(), true);
    expect(agent.cancel).not.toHaveBeenCalled();
  });
  it('records revoked deferred corrections so the UI cannot remain pending', () => {
    const agent = { ...makeAgent(), followup: vi.fn() }, actions: string[] = [];
    const c = new RecoveryController({ ...defaults, mode: 'assist' }, action => actions.push(action));
    c.request(agent, new AbortController().signal, false);
    c.setEnabled(agent, false); c.setEnabled(agent, true);
    expect(actions).toEqual(['correction-deferred', 'correction-revoked']);
  });
  it('revokes deferred assist corrections when switching mode to observe or guard', () => {
    for (const nextMode of ['observe', 'guard'] as const) {
      const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() }, actions: string[] = [];
      const c = new RecoveryController({ ...defaults, mode: 'assist' }, action => actions.push(action));
      c.request(agent, new AbortController().signal, true);
      c.setMode(nextMode);
      expect(actions).toEqual(['correction-deferred', 'correction-revoked']);
      c.request(agent, new AbortController().signal, true);
      expect(agent.cancel).toHaveBeenCalledTimes(nextMode === 'guard' ? 1 : 0);
    }
  });
  it('cannot intervene in observation mode or unverified hosts', () => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() };
    new RecoveryController(defaults, () => {}).request(agent, new AbortController().signal, true);
    new RecoveryController({ ...defaults, mode: 'auto' }, () => {}).request(agent, new AbortController().signal, false);
    expect(agent.cancel).not.toHaveBeenCalled(); expect(agent.followup).not.toHaveBeenCalled();
  });
  it('caps independent recovery turns and only resets for new user work', async () => {
    const agent = { ...makeAgent(), status: 'idle', followup: vi.fn(), inject: vi.fn() }, c = new RecoveryController({ ...defaults, mode: 'assist' }, () => {});
    for (let i = 0; i < 10; i++) {
      c.request(agent, new AbortController().signal, false);
      c.settled(agent, { reason: { kind: 'completed' } }); await Promise.resolve();
    }
    expect(agent.followup).toHaveBeenCalledTimes(2);
    expect(agent.inject).not.toHaveBeenCalled();
    c.resetByUser(agent); c.request(agent, new AbortController().signal, false);
    c.settled(agent, { reason: { kind: 'completed' } }); await Promise.resolve();
    expect(agent.followup).toHaveBeenCalledTimes(3);
  });
  it.each(['completed', 'max-tokens'])('defers assist until %s settlement and never injects into the current step', async kind => {
    const agent = { ...makeAgent(), followup: vi.fn(), inject: vi.fn() };
    const c = new RecoveryController({ ...defaults, mode: 'assist' }, () => {});
    for (let i = 0; i < 5; i++) c.request(agent, new AbortController().signal, false);
    expect(agent.followup).not.toHaveBeenCalled(); expect(agent.inject).not.toHaveBeenCalled();
    expect(agent.inbox!.nextStep).toEqual([]);
    agent.status = 'idle'; c.settled(agent, { reason: { kind } }); await Promise.resolve();
    expect(agent.followup).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'aborted', 'blocked', undefined])('discards deferred assist after %s without leaving messages', async kind => {
    const agent = { ...makeAgent(), status: 'idle', followup: vi.fn(), inject: vi.fn() };
    const c = new RecoveryController({ ...defaults, mode: 'assist' }, () => {});
    c.request(agent, new AbortController().signal, false);
    c.settled(agent, kind ? { reason: { kind } } : undefined); await Promise.resolve(); c.dispose();
    expect(agent.followup).not.toHaveBeenCalled(); expect(agent.inject).not.toHaveBeenCalled();
    expect(agent.inbox!.nextStep).toEqual([]);
  });
  it('does not resume before settlement and idle, and never calls tools', async () => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() }, c = new RecoveryController({ ...defaults, mode: 'auto' }, () => {});
    c.request(agent, new AbortController().signal, true);
    expect(agent.cancel).toHaveBeenCalledWith(expect.objectContaining({ kind: 'hook' }), { keepInbox: true });
    expect(agent.followup).not.toHaveBeenCalled();
    agent.status = 'idle'; c.settled(agent, ending); await Promise.resolve();
    expect(agent.followup).toHaveBeenCalledTimes(1);
  });
  it.each(['user-stop', 'queued-input', 'unload', 'new-user', 'disabled'])('suppresses recovery on %s', async scenario => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() }, c = new RecoveryController({ ...defaults, mode: 'auto' }, () => {});
    const controller = new AbortController();
    if (scenario === 'user-stop') controller.abort({ kind: 'user' });
    c.request(agent, controller.signal, true);
    agent.status = 'idle';
    if (scenario === 'queued-input') agent.inbox!.nextTurn = [{}];
    if (scenario === 'new-user') c.resetByUser(agent);
    if (scenario === 'disabled') c.setEnabled(agent, false);
    c.settled(agent, scenario === 'user-stop' ? { reason: { kind: 'aborted', reason: { kind: 'user' } } } : ending);
    if (scenario === 'unload') c.dispose();
    await Promise.resolve(); expect(agent.followup).not.toHaveBeenCalled();
  });
  it.each(['assist', 'auto'] as const)('revokes scheduled %s after idle before its microtask runs', async mode => {
    for (const action of ['reset', 'forget', 'disable', 'dispose', 'user-input', 'abort']) {
      if (mode === 'auto' && action === 'abort') continue; // Auto owns the original abort.
      const agent = { ...makeAgent(), status: 'idle', cancel: vi.fn(), followup: vi.fn() };
      const c = new RecoveryController({ ...defaults, mode }, () => {}), controller = new AbortController();
      c.request(agent, controller.signal, true);
      c.settled(agent, mode === 'auto' ? ending : { reason: { kind: 'max-tokens' } });
      if (action === 'reset') c.resetByUser(agent);
      if (action === 'forget') c.forget(agent);
      if (action === 'disable') c.setEnabled(agent, false);
      if (action === 'dispose') c.dispose();
      if (action === 'user-input') agent.inbox!.nextTurn = [{}];
      if (action === 'abort') controller.abort();
      await Promise.resolve(); expect(agent.followup).not.toHaveBeenCalled();
    }
  });
});
