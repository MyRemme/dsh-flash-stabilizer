import { randomUUID } from 'node:crypto';
import type { Agent, UserMessage } from './types.js';
import type { Settings } from './config.js';

export function correction(language: 'zh' | 'en'): UserMessage {
  const text = language === 'zh'
    ? '检测到当前步骤出现重复推理。请依据原任务和已有工具结果，先确认当前工作区状态，再继续下一项必要操作。不要重复已经完成的工作，不要自动重放写入、删除、Git 或部署操作；无法确认状态时明确说明阻塞原因。'
    : 'Repeated reasoning was detected. Use the original task and recorded tool outcomes, inspect the current workspace state, and continue the next necessary action. Do not repeat completed work or replay writes, deletions, Git operations or deployments. State the blocker if the outcome is uncertain.';
  return { id: randomUUID(), role: 'user', source: { kind: 'flash-stabilizer', form: 'notice', summary: 'DSH Flash Stabilizer: repeated reasoning detected' }, content: [{ type: 'text', text }] };
}

export class RecoveryController {
  private attempts = new Map<string, number>();
  private pending = new Map<Agent, { mode: 'assist' | 'auto' | 'guard'; signal: AbortSignal; scheduled: boolean; origin?: { turn: number; step: number } | undefined }>();
  private disabled = new Set<string>();
  private disposed = false;
  constructor(private readonly config: Settings, private readonly record: (action: string, agent: Agent, origin?: { turn: number; step: number }) => void) {}
  private revoke(agent: Agent, action = 'correction-revoked'): void {
    const pending = this.pending.get(agent);
    if (!pending) return;
    this.pending.delete(agent);
    this.record(pending.mode === 'guard' ? 'stop-unconfirmed' : action, agent, pending.origin);
  }
  resetByUser(agent: Agent): void {
    this.revoke(agent, 'user-input-takes-priority');
    this.attempts.delete(agent.id);
  }
  setEnabled(agent: Agent, enabled: boolean): void {
    if (enabled) this.disabled.delete(agent.id); else { this.disabled.add(agent.id); this.revoke(agent); }
  }
  request(agent: Agent, signal: AbortSignal, verified: boolean, origin?: { turn: number; step: number }): void {
    if (this.disposed || this.disabled.has(agent.id) || signal.aborted || this.pending.has(agent)) return;
    if (this.config.mode === 'observe') return;
    if (this.config.mode === 'guard') {
      if (!verified || !agent.cancel) { this.record('intervention-unavailable', agent, origin); return; }
      this.pending.set(agent, { mode: 'guard', signal, scheduled: false, origin });
      try {
        agent.cancel({ kind: 'hook', reason: 'dsh-flash-stabilizer: confirmed repetition' }, { keepInbox: true });
        this.record('cancel-requested', agent, origin);
      } catch { this.pending.delete(agent); this.record('stop-failed', agent, origin); }
      return;
    }
    const count = this.attempts.get(agent.id) ?? 0;
    if (count >= this.config.maxRecoveries) { this.record('budget-exhausted', agent, origin); return; }
    if (this.config.mode === 'assist') {
      if (!agent.followup || !agent.inbox) { this.record('intervention-unavailable', agent, origin); return; }
      this.attempts.set(agent.id, count + 1);
      this.pending.set(agent, { mode: 'assist', signal, scheduled: false, origin });
      this.record('correction-deferred', agent, origin);
      return;
    }
    if (!verified || !agent.cancel || !agent.followup || !agent.inbox) { this.record('intervention-unavailable', agent, origin); return; }
    this.attempts.set(agent.id, count + 1);
    const cause = { kind: 'hook' as const, reason: 'dsh-flash-stabilizer: confirmed repetition' };
    this.pending.set(agent, { mode: 'auto', signal, scheduled: false, origin });
    agent.cancel(cause, { keepInbox: true });
    this.record('cancel-requested', agent, origin);
  }
  /** Called after durable turn/end AND the driver's idle transition, outside dispatch. */
  settled(agent: Agent, ending?: Record<string, unknown>): void {
    const reason = ending?.reason as { kind?: string; reason?: { kind?: string; reason?: string } } | undefined;
    const pending = this.pending.get(agent);
    if (!pending || pending.scheduled) return;
    const owned = reason?.kind === 'aborted' && reason.reason?.kind === 'hook' && reason.reason.reason === 'dsh-flash-stabilizer: confirmed repetition';
    if (pending.mode === 'guard') {
      this.pending.delete(agent);
      this.record(owned ? 'stop-confirmed' : 'stop-unconfirmed', agent, pending.origin);
      return;
    }
    const eligible = pending.mode === 'auto' ? owned
      : !pending.signal.aborted && (reason?.kind === 'completed' || reason?.kind === 'max-tokens');
    if (!eligible) { this.revoke(agent); return; }
    pending.scheduled = true;
    // Never await whenIdle from a callback which the driver itself awaits.
    queueMicrotask(() => {
      try {
        // Keep the pending identity until dispatch so reset/forget can revoke a
        // queued microtask, including user input that arrives just after idle.
        if (this.pending.get(agent) !== pending) return;
        this.pending.delete(agent);
        if (this.disposed || this.disabled.has(agent.id) || agent.status !== 'idle' || pending.mode === 'assist' && pending.signal.aborted) { this.record('correction-revoked', agent, pending.origin); return; }
        if (!agent.inbox || agent.inbox.nextStep.length || agent.inbox.nextTurn.length) { this.record('user-input-takes-priority', agent, pending.origin); return; }
        agent.followup?.(correction(this.config.language));
        this.record('recovery-submitted', agent, pending.origin);
      } catch { this.record('recovery-failed', agent, pending.origin); }
    });
  }
  forget(agent: Agent): void { this.revoke(agent); this.attempts.delete(agent.id); this.disabled.delete(agent.id); }
  dispose(): void {
    this.disposed = true;
    for (const agent of this.pending.keys()) this.revoke(agent);
    this.pending.clear(); this.attempts.clear(); this.disabled.clear();
  }
}
