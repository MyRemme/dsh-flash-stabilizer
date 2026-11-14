import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSettings, Config, type Settings } from './config.js';
import { compatibilityFor, detectHostVersion } from './compatibility.js';
import { StreamMonitor } from './monitor.js';
import { ProgressGuard } from './progress.js';
import { MetricsStore, sessionKey, type DiagnosticEvent } from './metrics.js';
import { RecoveryController } from './recovery.js';
import { registerUI } from './ui-bridge.js';
import { registerUpdater } from './updater.js';
import { ModelScopeStore, type ModelCatalog } from './model-scope.js';
import type { Agent, Chunk, HostContext, Notice, RequestOptions, StepPayload, ToolExecution, ToolResult } from './types.js';

export { Config };
export const name = 'flash-stabilizer';
export const inject = ['agents', 'llm', 'tools'];
export interface StabilizerAPI {
  status(): {
    compatibility: ReturnType<typeof compatibilityFor>; mode: Settings['mode']; sessions: number; counts: Record<string, number>;
    monitoring: boolean; startedAt: string; monitoredRequests: number; finishedRequests: number; activeRequests: number; lastMonitoredAt: string | null;
    modelScope: ReturnType<ModelScopeStore['summary']>;
    confirmed: number; recoverySubmitted: number; events: ReturnType<MetricsStore['snapshot']>['events']; logging: ReturnType<MetricsStore['snapshot']>['logging'];
  };
  sessionStatus(sessionId: string): {
    monitoring: boolean; sessionEnabled: boolean; mode: Settings['mode']; startedAt: string;
    coverage: 'waiting' | 'monitoring' | 'checked' | 'other-model' | 'auxiliary' | 'unavailable' | 'paused' | 'disabled';
    monitoredRequests: number; activeRequests: number; confirmed: number; toolWarnings: number; recoverySubmitted: number; cancelRequested: number;
    lastMonitoredAt: string | null; latestEvent: DiagnosticEvent | null; events: ReturnType<MetricsStore['forSession']>;
    turn: number; step: number; toolResults: number; lastToolAt: string | null;
    counterScope: 'tracked' | 'retained-events';
    live: (ReturnType<StreamMonitor['snapshot']> & { turn: number; step: number; startedAt: string; active: boolean; silentForMs: number }) | null;
  };
  /** Owner UI only; excluded from status(), disk and export. */
  conversations(): ({ sessionId: string; sessionKey: string; tracked: boolean } & ReturnType<StabilizerAPI['sessionStatus']>)[];
  setMonitoring(enabled: boolean): void;
  setMode(mode: 'observe' | 'assist' | 'guard'): Promise<ReturnType<StabilizerAPI['status']>>;
  modelScope(): ReturnType<ModelScopeStore['view']>;
  setModelScope(input: unknown): Promise<ReturnType<ModelScopeStore['view']>>;
  refreshModels(): Promise<ReturnType<ModelScopeStore['view']>>;
  selfTest(): { passed: boolean; scope: 'offline-detector-only'; modelRequests: 0 };
  setSessionEnabled(sessionId: string, enabled: boolean): void;
}
interface RequestState { monitor: StreamMonitor; signal: AbortSignal; route: RequestOptions; frameId?: string; turn: number; step: number; startedAt: string }
interface SessionState {
  agent: Agent; turn: number; step: number; signal?: AbortSignal;
  route?: RequestOptions;
  request?: RequestState; activity?: RequestState;
  frameId?: string; progress: ProgressGuard; ending?: Record<string, unknown>;
  enabled: boolean; noticeKeys: Set<string>;
  coverage: 'waiting' | 'other-model' | 'auxiliary' | 'unavailable' | 'checked';
  monitoredRequests: number; confirmed: number; toolWarnings: number; recoverySubmitted: number; cancelRequested: number; lastMonitoredAt: string | null;
  latestEvent: DiagnosticEvent | null;
  toolResults: number; lastToolAt: string | null;
}

export function apply(ctx: HostContext, input: Partial<Settings> = {}): void {
  const config = resolveSettings(input);
  if (!config.enabled) return;
  // Launcher metadata can be provided while its fiber is still activating.
  const profile = ctx.get?.('profileContext', false) as { installAnchor?: string; dir?: string } | undefined;
  const detected = detectHostVersion(profile?.installAnchor);
  const compatibility = compatibilityFor(config.hostVersion || detected || '');
  // Explicit version is an observation hint, never permission to unlock recovery.
  if (config.hostVersion && detected !== config.hostVersion) { compatibility.intervention = false; compatibility.guard = false; }
  const modeFile = profile?.dir ? join(profile.dir, '.flash-stabilizer', 'mode.json') : undefined;
  let configuredMode: Settings['mode'] = config.mode;
  if (modeFile) {
    try {
      if (statSync(modeFile).size <= 65536) {
        const saved = JSON.parse(readFileSync(modeFile, 'utf8')) as { mode?: unknown };
        if (saved && typeof saved === 'object' && !Array.isArray(saved) && Object.keys(saved).length === 1 && ['observe', 'assist', 'guard'].includes(saved.mode as string)) {
          configuredMode = saved.mode as Settings['mode'];
        }
      }
    } catch { /* Optional saved mode. */ }
  }
  const modeFor = (requested: Settings['mode']): Settings['mode'] =>
    requested === 'auto' ? (compatibility.intervention ? 'auto' : compatibility.guard ? 'guard' : 'observe')
    : requested === 'guard' && !compatibility.guard ? 'observe' : requested;
  let effectiveMode = modeFor(configuredMode);
  let modeSaving: Promise<unknown> = Promise.resolve();
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
  const recovery = new RecoveryController({ ...config, mode: effectiveMode }, (action, agent, origin) => {
    const state = states.get(agent.id);
    report({ kind: 'recovery', session: agent.id, score: 0, confirmed: false, chars: 0, action,
      ...(origin ?? (state ? { turn: state.turn, step: state.step } : {})) });
  });
  const guarded = (operation: () => void, context?: SessionState | (() => SessionState | undefined)) => {
    if (disposed) return;
    try { operation(); }
    catch (error) {
      const state = typeof context === 'function' ? context() : context;
      if (state) { state.coverage = 'unavailable'; state.activity?.monitor.invalidate(); }
      const action = error instanceof TypeError ? 'type-error' : error instanceof RangeError ? 'range-error' : 'unexpected-error';
      report({ kind: 'internal-error', session: state?.agent.id ?? '', score: 0, confirmed: false, chars: 0, action,
        ...(state ? { turn: state.turn, step: state.step } : {}) });
      warn(`flash-stabilizer: monitor unavailable (${action}); output is still forwarded`);
    }
  };
  const routeOf = (route: RequestOptions) => ({
    ...(typeof route.model === 'string' ? { model: route.model } : {}),
    ...(typeof route.provider === 'string' ? { provider: route.provider } : {}),
  });
  const modelScope = new ModelScopeStore({ scope: config.modelScope,
    selections: config.modelSelections.length ? config.modelSelections : config.models.flatMap(model =>
      config.providers.length ? config.providers.map(provider => ({ model, provider })) : [{ model }]),
  }, profile?.dir, () => {
    for (const state of states.values()) {
      const eligible = modelScope.matches(state.request?.route ?? state.route ?? {});
      if (!eligible) { state.coverage = 'other-model'; delete state.request; state.progress.clear(); }
      else if (state.coverage === 'other-model') state.coverage = 'waiting';
      recovery.setEnabled(state.agent, monitoring && state.enabled && eligible);
    }
  });
  const selected = (options: RequestOptions) => modelScope.matches(options);
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
    recovery.setEnabled(agent, enabled && monitoring && selected(agent.model?.current() ?? agent.options ?? {}));
    state = { agent, turn: 0, step: 0, progress: new ProgressGuard(config.toolRepeatLimit), enabled, noticeKeys: new Set(),
      coverage: 'waiting', monitoredRequests: 0, confirmed: 0, toolWarnings: 0, recoverySubmitted: 0, cancelRequested: 0, lastMonitoredAt: null, latestEvent: null, toolResults: 0, lastToolAt: null };
    states.set(agent.id, state);
    return state;
  };
  ctx.on('agent/pre-step', (payload: StepPayload, next: () => Promise<unknown>) => {
    guarded(() => {
      const state = stateFor(payload.agent);
      state.turn = payload.turn; state.step = payload.step; state.signal = payload.signal;
      delete state.frameId;
      state.route = routeOf(payload.modelSelection ?? payload.agent.model?.current() ?? payload.agent.options ?? {});
      modelScope.remember(state.route);
      recovery.setEnabled(state.agent, monitoring && state.enabled && selected(state.route));
      if (payload.messages.some(m => m.source?.kind === 'user')) {
        recovery.resetByUser(payload.agent); state.progress.clear(); state.noticeKeys.clear();
      }
    }, () => states.get(payload.agent.id));
    return next(); // Preserve downstream decisions, messages and startsRequestSeries verbatim.
  });
  ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: Agent; message: { source?: { kind?: string } } }) => {
    if (message.source?.kind === 'user') guarded(() => recovery.resetByUser(agent), states.get(agent.id));
  });

  ctx.on('llm/stream', (options: RequestOptions, next: () => AsyncIterable<Chunk>) => {
    // Delegate exactly once, outside our error containment: host failures remain authoritative.
    const upstream = next();
    const state = options.sessionId ? states.get(options.sessionId) : undefined;
    if (state && !disposed && !options.purpose) {
      modelScope.remember(options);
      if (!state.request) state.route = routeOf(options);
    }
    if (state && !disposed && options.purpose && !state.request && !state.monitoredRequests) state.coverage = 'auxiliary';
    if (state && !disposed && !options.purpose && !state.request) {
      state.coverage = !selected(options) ? 'other-model' : !options.signal || options.signal !== state.signal ? 'unavailable' : 'waiting';
    }
    if (disposed || !monitoring || !state?.enabled || !selected(options) || options.purpose || !options.signal || options.signal !== state.signal) return upstream;
    return (async function* () {
      const signal = options.signal!;
      let request: SessionState['request'];
      guarded(() => {
        if (!monitoring || !state.enabled || !selected(options) || states.get(state.agent.id) !== state || signal !== state.signal) return;
        const origin = { turn: state.turn, step: state.step }, noticeKeys = new Set<string>();
        const monitor = new StreamMonitor(config, evidence => {
          const willIntervene = evidence.confirmed && !evidence.uncertainty && effectiveMode !== 'observe'
            && (effectiveMode !== 'guard' || evidence.contentType === 'reasoning')
            && selected(options) && !signal.aborted && signal === state.signal && origin.turn === state.turn && origin.step === state.step
            && state.agent === states.get(state.agent.id)?.agent && monitoring && state.enabled;
          const key = `${evidence.contentType}/${evidence.uncertainty ? 'uncertain' : evidence.confirmed ? 'confirmed' : 'suspected'}`;
          if (!noticeKeys.has(key)) {
            noticeKeys.add(key);
            report({ kind: 'stream-repeat', session: state.agent.id, score: evidence.score, confirmed: evidence.confirmed, chars: evidence.chars,
              period: evidence.period, repeats: evidence.repeats, coverage: evidence.coverage, novelty: evidence.novelty,
              ...(evidence.method ? { method: evidence.method } : {}),
              ...(evidence.uncertainty ? { uncertainty: evidence.uncertainty } : {}),
              action: evidence.uncertainty ? 'notify-only' : willIntervene ? 'awaiting-recovery-decision' : 'observe-only', contentType: evidence.contentType, ...origin });
          }
          if (willIntervene)
            recovery.request(state.agent, signal, effectiveMode === 'guard' ? compatibility.guard : compatibility.intervention, origin);
        });
        state.noticeKeys.clear();
        state.latestEvent = null;
        state.route = routeOf(options);
        recovery.setEnabled(state.agent, monitoring && state.enabled && selected(options));
        request = { monitor, signal, route: state.route, turn: state.turn, step: state.step, startedAt: new Date().toISOString(), ...(state.frameId ? { frameId: state.frameId } : {}) };
        delete state.frameId; // A pre-stream start frame is consumed once, including retries in the same step.
        state.activity = request;
        state.request = request;
        monitoredRequests++; lastMonitoredAt = new Date().toISOString();
        state.monitoredRequests++; state.lastMonitoredAt = lastMonitoredAt; state.coverage = 'checked';
      }, state);
      const ownRequest = request;
      let completed = false;
      try {
        for await (const chunk of upstream) {
          if (compatibility.adapter === 'stream-waterfall' && ownRequest && state.request === ownRequest) guarded(() => ownRequest.monitor.push(chunk), state);
          yield chunk;
        }
        completed = true;
      } finally {
        if (ownRequest) {
          finishedRequests++;
          if (state.request === ownRequest) {
            if (!completed) state.coverage = 'unavailable';
            if (state.frameId === ownRequest.frameId) delete state.frameId;
            delete state.request;
          }
        }
      }
    })();
  });

  if (compatibility.adapter === 'live-frames') {
    ctx.on('agent/assistant-stream', ({ agent, frame }: { agent: Agent; frame: { type: string; attemptId: string; chunk?: Chunk } }) => {
      const state = states.get(agent.id);
      if (!state || state.agent !== agent) return;
      guarded(() => {
        const request = state.request;
        const current = request && request.signal === state.signal && request.turn === state.turn && request.step === state.step;
        if (frame.type === 'start') {
          if (current && request.frameId === frame.attemptId) return;
          if (current && !request.frameId) request.frameId = frame.attemptId;
          else state.frameId = frame.attemptId;
          return;
        }
        if (frame.type === 'chunk' && frame.chunk && monitoring && state.enabled && current && request.frameId === frame.attemptId) request.monitor.push(frame.chunk);
      }, state);
    });
  }
  ctx.on('tools/result', (exec: ToolExecution, result: ToolResult) => guarded(() => {
    if (!exec.agent) return;
    const state = states.get(exec.agent.id);
    if (!monitoring || !state?.enabled || state.agent !== exec.agent) return;
    const route = exec.agent.model?.current() ?? exec.agent.options;
    if (!selected(route ?? {})) return;
    state.toolResults++; state.lastToolAt = new Date().toISOString();
    const evidence = state.progress.record(exec, result);
    if (evidence.repeated && evidence.count % config.toolRepeatLimit === 0) {
      const extra = Math.min(10, Math.floor((evidence.count - config.toolRepeatLimit) / config.toolRepeatLimit) * 5);
      report({ kind: 'tool-repeat', session: exec.agent.id, score: (evidence.failed ? 85 : 70) + extra, confirmed: false, chars: 0,
        repeats: evidence.count, turn: state.turn, step: state.step });
      // Repetition of a tool is observation only; never skip, deny, or replay it.
    }
  }, exec.agent ? states.get(exec.agent.id) : undefined));
  ctx.on('session/event', (session: { id: string }, event: { type: string; data: Record<string, unknown> }) => guarded(() => {
    if (event.type === 'turn/end') {
      const state = states.get(session.id);
      if (state) state.ending = event.data;
    }
  }, states.get(session.id)));
  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => guarded(() => {
    const state = states.get(agent.id);
    if (status !== 'idle' || !state || state.agent !== agent) return;
    recovery.settled(agent, state.ending);
    delete state.ending;
    delete state.request; delete state.signal; delete state.frameId;
  }, states.get(agent.id)));
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => guarded(() => {
    if (states.get(agent.id)?.agent === agent) states.delete(agent.id);
    recovery.forget(agent);
  }, states.get(agent.id)));
  const api: StabilizerAPI = {
    sessionStatus: sessionId => {
      const state = states.get(sessionId);
      const activity = state?.activity, live = activity?.monitor.snapshot();
      const events = metrics.forSession(sessionId);
      const retained = (kind: string, action?: string) => events.filter(event => event.kind === kind && (action ? event.action === action : event.confirmed)).length;
      return {
        monitoring: monitoring && !disposed, sessionEnabled: !disabledSessions.has(sessionId), mode: effectiveMode, startedAt,
        coverage: !monitoring || disposed ? 'paused' : disabledSessions.has(sessionId) ? 'disabled'
          : state?.request ? 'monitoring' : state?.coverage ?? 'waiting',
        monitoredRequests: state?.monitoredRequests ?? 0, activeRequests: state?.request ? 1 : 0,
        counterScope: state ? 'tracked' : 'retained-events',
        confirmed: state?.confirmed ?? retained('stream-repeat'), toolWarnings: state?.toolWarnings ?? events.filter(e => e.kind === 'tool-repeat').length,
        recoverySubmitted: state?.recoverySubmitted ?? retained('recovery', 'recovery-submitted'), cancelRequested: state?.cancelRequested ?? retained('recovery', 'cancel-requested'),
        lastMonitoredAt: state?.lastMonitoredAt ?? null, latestEvent: state?.latestEvent ? { ...state.latestEvent } : state ? null : events[0] ?? null, events,
        turn: state?.turn ?? 0, step: state?.step ?? 0, toolResults: state?.toolResults ?? 0, lastToolAt: state?.lastToolAt ?? null,
        live: activity && live ? { ...live, turn: activity.turn, step: activity.step, startedAt: activity.startedAt,
          active: state.request === activity, silentForMs: state.request === activity ? Math.max(0, Date.now() - Date.parse(live.lastOutputAt ?? activity.startedAt)) : 0 } : null,
      };
    },
    conversations: () => {
      const ids = new Set([...states.keys(), ...metrics.sessionReferences().map(item => item.sessionId)]);
      return [...ids].map(sessionId => ({ sessionId, sessionKey: sessionKey(sessionId), tracked: states.has(sessionId), ...api.sessionStatus(sessionId) }))
        .sort((a, b) => b.activeRequests - a.activeRequests || (b.lastMonitoredAt ?? '').localeCompare(a.lastMonitoredAt ?? ''));
    },
    status: () => ({
      compatibility: { ...compatibility }, mode: effectiveMode, sessions: states.size, counts: { ...metrics.counts },
      modelScope: modelScope.summary(),
      monitoring: monitoring && !disposed, startedAt, monitoredRequests, finishedRequests,
      activeRequests: [...states.values()].filter(state => state.request).length,
      lastMonitoredAt, ...metrics.snapshot(),
    }),
    setMonitoring: enabled => guarded(() => {
      monitoring = enabled;
      for (const state of states.values()) {
        if (!enabled && state.request) { state.coverage = 'unavailable'; delete state.request; }
        recovery.setEnabled(state.agent, enabled && state.enabled && selected(state.request?.route ?? state.route ?? {}));
      }
    }),
    setMode: nextMode => {
      if (!['observe', 'assist', 'guard'].includes(nextMode)) return Promise.reject(new TypeError('invalid mode'));
      if (nextMode === 'guard' && !compatibility.guard) return Promise.reject(new Error('guard mode unavailable'));
      const operation = modeSaving.catch(() => {}).then(async () => {
        if (disposed) throw new Error('settings unavailable');
        if (modeFile) {
          const temporary = `${modeFile}.${randomUUID()}.tmp`;
          await mkdir(dirname(modeFile), { recursive: true });
          try {
            await writeFile(temporary, JSON.stringify({ mode: nextMode }, null, 2) + '\n', { mode: 0o600 });
            await rename(temporary, modeFile);
          } finally { await unlink(temporary).catch(() => {}); }
        }
        configuredMode = nextMode;
        effectiveMode = modeFor(nextMode);
        recovery.setMode(effectiveMode);
        return api.status();
      });
      modeSaving = operation;
      return operation;
    },
    modelScope: () => modelScope.view(),
    setModelScope: input => modelScope.set(input),
    refreshModels: () => modelScope.refresh((ctx.get?.('llm', false) ?? ctx.llm) as ModelCatalog | undefined),
    selfTest: () => {
      const passed = ['好。执行。好。', '好。'].every(unit => {
        let confirmed = false;
        const monitor = new StreamMonitor(config, evidence => { if (evidence.confirmed) confirmed = true; });
        monitor.push({ type: 'reasoning-delta', index: 0, text: unit.repeat(Math.ceil(config.windowChars * 3 / unit.length)) });
        return confirmed;
      });
      return { passed, scope: 'offline-detector-only', modelRequests: 0 };
    },
    setSessionEnabled: (sessionId, enabled) => guarded(() => {
      if (enabled) disabledSessions.delete(sessionId); else disabledSessions.add(sessionId);
      const agent = states.get(sessionId)?.agent ?? ctx.agents?.get(sessionId);
      if (!agent) return;
      const state = stateFor(agent); state.enabled = enabled;
      if (!enabled && state.request) { state.coverage = 'unavailable'; delete state.request; }
      recovery.setEnabled(agent, enabled && monitoring && selected(state.request?.route ?? state.route ?? agent.model?.current() ?? agent.options ?? {}));
    }),
  };
  ctx.provide?.('flashStabilizer', api);
  const updates = registerUpdater(ctx, detected ?? '', () => {
    const agents = ctx.agents?.list?.();
    return !!agents && agents.every(agent => agent.status === 'idle' && !agent.inbox?.nextStep.length && !agent.inbox?.nextTurn.length)
      && api.status().activeRequests === 0;
  });
  registerUI(ctx, api, updates);
  if (configuredMode !== effectiveMode) warn(config.language === 'zh' ? 'Flash Stabilizer：此版本尚未通过所选干预模式验证，已使用观察模式。' : 'Flash Stabilizer: selected intervention is not verified; using observation mode.');
  metrics.record({ kind: 'compatibility', session: '', score: 0, confirmed: false, chars: 0, action: compatibility.reason });
  try { ctx.logger?.info(`flash-stabilizer: DSH ${compatibility.version}; ${compatibility.adapter}; ${effectiveMode}; ${compatibility.reason}`); } catch { /* Optional logger. */ }
  ctx.effect(() => async () => { disposed = true; recovery.dispose(); states.clear(); await modeSaving.catch(() => {}); await modelScope.close(); await metrics.close(); }, 'flash-stabilizer: stop and drain');
}
