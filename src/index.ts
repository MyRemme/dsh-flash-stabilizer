import { resolveSettings, Config, type Settings } from './config.js';
import { compatibilityFor, detectHostVersion } from './compatibility.js';
import { StreamMonitor } from './monitor.js';
import { ProgressGuard } from './progress.js';
import { MetricsStore, type DiagnosticEvent } from './metrics.js';
import { RecoveryController } from './recovery.js';
import { registerUI } from './ui-bridge.js';
import type { Agent, Chunk, HostContext, Notice, RequestOptions, StepPayload, ToolExecution, ToolResult } from './types.js';

export { Config };
export const name = 'flash-stabilizer';
export const inject = ['agents', 'llm', 'tools'];
export interface StabilizerAPI {
  status(): {
    compatibility: ReturnType<typeof compatibilityFor>; mode: Settings['mode']; sessions: number; counts: Record<string, number>;
    monitoring: boolean; startedAt: string; monitoredRequests: number; finishedRequests: number; activeRequests: number; lastMonitoredAt: string | null;
    confirmed: number; recoverySubmitted: number; events: ReturnType<MetricsStore['snapshot']>['events']; logging: ReturnType<MetricsStore['snapshot']>['logging'];
  };
  sessionStatus(sessionId: string): {
    monitoring: boolean; mode: Settings['mode']; startedAt: string;
    coverage: 'waiting' | 'monitoring' | 'checked' | 'other-model' | 'auxiliary' | 'unavailable' | 'paused' | 'disabled';
    monitoredRequests: number; activeRequests: number; confirmed: number; toolWarnings: number; recoverySubmitted: number; cancelRequested: number;
    lastMonitoredAt: string | null; latestEvent: DiagnosticEvent | null; events: ReturnType<MetricsStore['forSession']>;
  };
  setMonitoring(enabled: boolean): void;
  selfTest(): { passed: boolean; scope: 'offline-detector-only'; modelRequests: 0 };
  setSessionEnabled(sessionId: string, enabled: boolean): void;
}
interface SessionState {
  agent: Agent; turn: number; step: number; signal?: AbortSignal;
  request?: { monitor: StreamMonitor; signal: AbortSignal; frameId?: string };
  frameId?: string; progress: ProgressGuard; ending?: Record<string, unknown>;
  enabled: boolean; noticeKeys: Set<string>;
  coverage: 'waiting' | 'other-model' | 'auxiliary' | 'unavailable' | 'checked';
  monitoredRequests: number; confirmed: number; toolWarnings: number; recoverySubmitted: number; cancelRequested: number; lastMonitoredAt: string | null;
  latestEvent: DiagnosticEvent | null;
}

export function apply(ctx: HostContext, input: Partial<Settings> = {}): void {
  const config = resolveSettings(input);
  if (!config.enabled) return;
  const detected = detectHostVersion();
  const compatibility = compatibilityFor(config.hostVersion || detected || '');
  // Explicit version is an observation hint, never permission to unlock recovery.
  if (config.hostVersion && detected !== config.hostVersion) compatibility.intervention = false;
  const effectiveMode = config.mode === 'auto' && !compatibility.intervention ? 'observe' : config.mode;
  const states = new Map<string, SessionState>();
  const disabledSessions = new Set<string>(config.disabledSessions);
  let disposed = false;
  let monitoring = true;
  const startedAt = new Date().toISOString();
  let monitoredRequests = 0, finishedRequests = 0;
  let lastMonitoredAt: string | null = null;
  const warn = (message: string) => { try { ctx.logger?.warn(message); } catch { /* Logging is optional. */ } };
  const metrics = new MetricsStore(config.logDir, config.maxLogBytes, () => warn('flash-stabilizer: diagnostic logging disabled after an I/O error'));
  const report = (event: Notice) => {
    const safe = metrics.record(event);
    const state = states.get(event.session);
    if (state) {
      if (safe) state.latestEvent = safe;
      if (event.kind === 'stream-repeat' && event.confirmed) state.confirmed++;
      if (event.kind === 'tool-repeat') state.toolWarnings++;
      if (event.kind === 'recovery' && event.action === 'recovery-submitted') state.recoverySubmitted++;
      if (event.kind === 'recovery' && event.action === 'cancel-requested') state.cancelRequested++;
    }
    if (event.kind !== 'recovery' && event.score < 70) return;
    warn(config.language === 'zh'
      ? `Flash Stabilizer：${event.kind}，风险分数 ${event.score}，动作 ${event.action ?? 'observe'}；详情见「Flash 防空转」面板。`
      : `Flash Stabilizer: ${event.kind}, risk ${event.score}, action ${event.action ?? 'observe'}.`);
  };
  const recovery = new RecoveryController(config, (action, agent) => {
    const state = states.get(agent.id);
    report({ kind: 'recovery', session: agent.id, score: 0, confirmed: false, chars: 0, action,
      ...(state ? { turn: state.turn, step: state.step } : {}) });
  });
  const guarded = (operation: () => void) => {
    if (disposed) return;
    try { operation(); }
    catch { metrics.record({ kind: 'internal-error', session: '', score: 0, confirmed: false, chars: 0 }); }
  };
  const stateFor = (agent: Agent): SessionState => {
    let state = states.get(agent.id);
    if (state?.agent === agent) {
      states.delete(agent.id);
      states.set(agent.id, state);
      return state;
    }
    if (state) { recovery.forget(state.agent); states.delete(agent.id); }
    if (states.size >= config.maxSessions) {
      const idle = [...states.values()].find(s => !s.request && s.agent.status !== 'running');
      if (!idle) throw new RangeError('session capacity reached');
      recovery.forget(idle.agent); states.delete(idle.agent.id);
    }
    const enabled = !disabledSessions.has(agent.id);
    recovery.setEnabled(agent, enabled && monitoring);
    state = { agent, turn: 0, step: 0, progress: new ProgressGuard(config.toolRepeatLimit), enabled, noticeKeys: new Set(),
      coverage: 'waiting', monitoredRequests: 0, confirmed: 0, toolWarnings: 0, recoverySubmitted: 0, cancelRequested: 0, lastMonitoredAt: null, latestEvent: null };
    states.set(agent.id, state);
    return state;
  };
  const selected = (options: RequestOptions) => typeof options.model === 'string'
    && (config.models.includes(options.model) || config.models.includes(options.model.split(/[/:]/).at(-1)!))
    && (!config.providers.length || (typeof options.provider === 'string' && config.providers.includes(options.provider)));

  ctx.on('agent/pre-step', (payload: StepPayload, next: () => Promise<unknown>) => {
    guarded(() => {
      const state = stateFor(payload.agent);
      state.turn = payload.turn; state.step = payload.step; state.signal = payload.signal;
      if (payload.messages.some(m => m.source?.kind === 'user')) {
        recovery.resetByUser(payload.agent); state.progress.clear(); state.noticeKeys.clear();
      }
    });
    return next(); // Preserve downstream decisions, messages and startsRequestSeries verbatim.
  });
  ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: Agent; message: { source?: { kind?: string } } }) => {
    if (message.source?.kind === 'user') guarded(() => recovery.resetByUser(agent));
  });

  ctx.on('llm/stream', (options: RequestOptions, next: () => AsyncIterable<Chunk>) => {
    // Delegate exactly once, outside our error containment: host failures remain authoritative.
    const upstream = next();
    const state = options.sessionId ? states.get(options.sessionId) : undefined;
    if (state && !disposed && options.purpose && !state.request && !state.monitoredRequests) state.coverage = 'auxiliary';
    if (state && !disposed && !options.purpose && !state.request) {
      state.coverage = !selected(options) ? 'other-model' : !options.signal || options.signal !== state.signal ? 'unavailable' : 'waiting';
    }
    if (disposed || !monitoring || !state?.enabled || !selected(options) || options.purpose || !options.signal || options.signal !== state.signal) return upstream;
    return (async function* () {
      const signal = options.signal!;
      let request: SessionState['request'];
      guarded(() => {
        if (!monitoring || !state.enabled || states.get(state.agent.id) !== state || signal !== state.signal) return;
        const monitor = new StreamMonitor(config, evidence => {
          const key = evidence.confirmed ? 'confirmed' : 'suspected';
          if (!state.noticeKeys.has(key)) {
            state.noticeKeys.add(key);
            report({ kind: 'stream-repeat', session: state.agent.id, score: evidence.score, confirmed: evidence.confirmed, chars: evidence.chars,
              period: evidence.period, repeats: evidence.repeats, contentType: evidence.contentType, turn: state.turn, step: state.step });
          }
          if (evidence.confirmed) recovery.request(state.agent, signal, compatibility.intervention);
        });
        state.noticeKeys.clear();
        state.latestEvent = null;
        request = { monitor, signal, ...(state.frameId ? { frameId: state.frameId } : {}) };
        state.request = request;
        monitoredRequests++; lastMonitoredAt = new Date().toISOString();
        state.monitoredRequests++; state.lastMonitoredAt = lastMonitoredAt; state.coverage = 'checked';
      });
      const ownRequest = request;
      let completed = false;
      try {
        for await (const chunk of upstream) {
          if (compatibility.adapter === 'stream-waterfall' && ownRequest && state.request === ownRequest) guarded(() => ownRequest.monitor.push(chunk));
          yield chunk;
        }
        completed = true;
      } finally {
        if (ownRequest) {
          finishedRequests++;
          if (state.request === ownRequest) {
            if (!completed) state.coverage = 'unavailable';
            delete state.request;
          }
        }
      }
    })();
  });

  if (compatibility.adapter === 'live-frames') {
    ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: Agent; frame: { type: string; attemptId: string; chunk?: Chunk } }) => guarded(() => {
      const state = states.get(agent.id);
      if (!state || state.agent !== agent) return;
      if (frame.type === 'start') { state.frameId = frame.attemptId; if (state.request) state.request.frameId = frame.attemptId; return; }
      if (frame.type === 'chunk' && frame.chunk && state.enabled && state.request?.frameId === frame.attemptId) state.request.monitor.push(frame.chunk);
    }));
  }
  ctx.on('tools/result', (exec: ToolExecution, result: ToolResult) => guarded(() => {
    if (!exec.agent) return;
    const state = states.get(exec.agent.id);
    if (!monitoring || !state?.enabled || state.agent !== exec.agent) return;
    const route = exec.agent.model?.current() ?? exec.agent.options;
    if (!selected(route ?? {})) return;
    const evidence = state.progress.record(exec, result);
    if (evidence.repeated && evidence.count === config.toolRepeatLimit) {
      report({ kind: 'tool-repeat', session: exec.agent.id, score: evidence.failed ? 85 : 70, confirmed: false, chars: 0,
        repeats: evidence.count, turn: state.turn, step: state.step });
      // Repetition of a tool is observation only; never skip, deny, or replay it.
    }
  }));
  ctx.on('session/event', (session: { id: string }, event: { type: string; data: Record<string, unknown> }) => guarded(() => {
    if (event.type === 'turn/end') {
      const state = states.get(session.id);
      if (state) state.ending = event.data;
    }
  }));
  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => guarded(() => {
    const state = states.get(agent.id);
    if (status !== 'idle' || !state || state.agent !== agent) return;
    recovery.settled(agent, state.ending);
    delete state.ending;
    delete state.request; delete state.signal;
  }));
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => guarded(() => {
    if (states.get(agent.id)?.agent === agent) states.delete(agent.id);
    recovery.forget(agent);
  }));
  const api: StabilizerAPI = {
    sessionStatus: sessionId => {
      const state = states.get(sessionId);
      return {
        monitoring: monitoring && !disposed, mode: effectiveMode, startedAt,
        coverage: !monitoring || disposed ? 'paused' : disabledSessions.has(sessionId) ? 'disabled'
          : state?.request ? 'monitoring' : state?.coverage ?? 'waiting',
        monitoredRequests: state?.monitoredRequests ?? 0, activeRequests: state?.request ? 1 : 0,
        confirmed: state?.confirmed ?? 0, toolWarnings: state?.toolWarnings ?? 0,
        recoverySubmitted: state?.recoverySubmitted ?? 0, cancelRequested: state?.cancelRequested ?? 0,
        lastMonitoredAt: state?.lastMonitoredAt ?? null, latestEvent: state?.latestEvent ? { ...state.latestEvent } : null, events: metrics.forSession(sessionId),
      };
    },
    status: () => ({
      compatibility: { ...compatibility }, mode: effectiveMode, sessions: states.size, counts: { ...metrics.counts },
      monitoring: monitoring && !disposed, startedAt, monitoredRequests, finishedRequests,
      activeRequests: [...states.values()].filter(state => state.request).length,
      lastMonitoredAt, ...metrics.snapshot(),
    }),
    setMonitoring: enabled => guarded(() => {
      monitoring = enabled;
      for (const state of states.values()) {
        if (!enabled && state.request) { state.coverage = 'unavailable'; delete state.request; }
        recovery.setEnabled(state.agent, enabled && state.enabled);
      }
    }),
    selfTest: () => {
      let passed = false;
      const monitor = new StreamMonitor(config, evidence => { if (evidence.confirmed) passed = true; });
      monitor.push({ type: 'reasoning-delta', index: 0, text: '好。执行。好。'.repeat(Math.ceil(config.windowChars * 3 / 7)) });
      return { passed, scope: 'offline-detector-only', modelRequests: 0 };
    },
    setSessionEnabled: (sessionId, enabled) => guarded(() => {
      if (enabled) disabledSessions.delete(sessionId); else disabledSessions.add(sessionId);
      const agent = states.get(sessionId)?.agent ?? ctx.agents?.get(sessionId);
      if (!agent) return;
      const state = stateFor(agent); state.enabled = enabled;
      if (!enabled && state.request) { state.coverage = 'unavailable'; delete state.request; }
      recovery.setEnabled(agent, enabled && monitoring);
    }),
  };
  ctx.provide?.('flashStabilizer', api);
  registerUI(ctx, api);
  if (config.mode !== effectiveMode) warn(config.language === 'zh' ? 'Flash Stabilizer：此版本尚未通过自动干预验证，已使用观察模式。' : 'Flash Stabilizer: automatic intervention is not verified; using observation mode.');
  metrics.record({ kind: 'compatibility', session: '', score: 0, confirmed: false, chars: 0, action: compatibility.reason });
  try { ctx.logger?.info(`flash-stabilizer: DSH ${compatibility.version}; ${compatibility.adapter}; ${effectiveMode}; ${compatibility.reason}`); } catch { /* Optional logger. */ }
  ctx.effect(() => async () => { disposed = true; recovery.dispose(); states.clear(); await metrics.close(); }, 'flash-stabilizer: stop and drain');
}
