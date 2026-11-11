import { describe, expect, it, vi } from 'vitest';
import { defaults } from '../src/config.js';
import { RecoveryController } from '../src/recovery.js';
import { makeAgent } from './helpers.js';
const ending = { reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'dsh-flash-stabilizer: confirmed repetition' } } };
describe('bounded recovery', () => {
  it('cannot intervene in observation mode or unverified hosts', () => {
    const agent = { ...makeAgent(), cancel: vi.fn(), followup: vi.fn() };
    new RecoveryController(defaults, () => {}).request(agent, new AbortController().signal, true);
    new RecoveryController({ ...defaults, mode: 'auto' }, () => {}).request(agent, new AbortController().signal, false);
    expect(agent.cancel).not.toHaveBeenCalled(); expect(agent.followup).not.toHaveBeenCalled();
  });
  it('caps corrections across calls and only resets for new user work', () => {
    const agent = { ...makeAgent(), inject: vi.fn() }, c = new RecoveryController({ ...defaults, mode: 'assist' }, () => {});
    for (let i = 0; i < 10; i++) c.request(agent, new AbortController().signal, false);
    expect(agent.inject).toHaveBeenCalledTimes(2);
    c.resetByUser(agent); c.request(agent, new AbortController().signal, false);
    expect(agent.inject).toHaveBeenCalledTimes(3);
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
});
