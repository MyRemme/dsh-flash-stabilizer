// Native Harness module. Display state never enters the model's conversation.
window.__ModuleLoader__.load({
  id: 'dsh-flash-stabilizer',
  factory: require => {
    const React = require('react'), { createPortal } = require('react-dom');
    const UI = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement, PANEL = 'flash-stabilizer';
    const css = `
      .fs-root,.fs-dialog,.fs-toast{font:13px/20px var(--dsw-font-family,system-ui,sans-serif);letter-spacing:0;color:var(--dsw-alias-label-primary);box-sizing:border-box;overflow-wrap:anywhere}
      .fs-root{height:100%;overflow:auto;padding:28px 32px 40px}.fs-page{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:28px}
      .fs-head,.fs-row,.fs-tools,.fs-state,.fs-event-head{display:flex;align-items:center;gap:8px;min-width:0}.fs-head{justify-content:space-between;gap:16px;flex-wrap:wrap}.fs-head h2{font-size:20px;line-height:28px;font-weight:500;margin:0}.fs-sub,.fs-muted{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.fs-sub{margin:4px 0 0}.fs-tools{gap:4px;flex-wrap:wrap}.fs-state{font-size:12px;color:var(--dsw-alias-label-secondary)}
      .fs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}.fs-state[data-tone=warn],.fs-warn{color:var(--dsw-alias-state-warn-primary)}.fs-state[data-tone=warn] .fs-dot{background:currentColor}.fs-state[data-tone=off]{color:var(--dsw-alias-label-tertiary)}.fs-state[data-tone=off] .fs-dot{background:currentColor}
      .fs-icon-button{width:28px!important;height:28px!important;padding:0!important;flex:none}.fs-action{height:28px;font-size:12px!important}.fs-switch{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-right:12px}
      .fs-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;border-top:.5px solid var(--dsw-alias-border-l2);border-bottom:.5px solid var(--dsw-alias-border-l2)}.fs-stat{padding:18px 16px;border-left:.5px solid var(--dsw-alias-border-l2)}.fs-stat:first-child{border-left:0;padding-left:0}.fs-stat dt{color:var(--dsw-alias-label-tertiary);font-size:12px}.fs-stat dd{font-size:24px;line-height:32px;font-weight:500;font-variant-numeric:tabular-nums;margin:4px 0 0}
      .fs-section h3{font-size:14px;line-height:22px;font-weight:500;margin:0}.fs-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.fs-facts{margin:0}.fs-fact{display:flex;justify-content:space-between;align-items:baseline;gap:20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.fs-fact dt{color:var(--dsw-alias-label-secondary);flex:none}.fs-fact dd{margin:0;text-align:right;min-width:0}.fs-note{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}.fs-empty{padding:28px 0;color:var(--dsw-alias-label-tertiary);text-align:center;border-top:.5px solid var(--dsw-alias-border-l2)}
      .fs-events{list-style:none;padding:0;margin:0}.fs-event{padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}.fs-event-head{justify-content:space-between;align-items:baseline;gap:12px}.fs-event-title{font-weight:500;font-size:13px}.fs-event time{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}.fs-event p{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.fs-event .fs-result{color:var(--dsw-alias-label-primary)}.fs-tag{font-size:11px;line-height:18px;padding:0 5px;border-radius:var(--dsw-radius-sm,4px);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap}.fs-error{color:var(--dsw-alias-state-error-primary);margin:0}.fs-test{color:var(--dsw-alias-state-success-primary);margin:0}
      .fs-dock{position:relative;min-width:0;max-width:100%;display:inline-flex}.fs-dock-button{font:11px/18px var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-tertiary);border:0;background:transparent;padding:2px 4px;border-radius:var(--dsw-radius-sm,4px);display:inline-flex;align-items:center;gap:5px;cursor:pointer;min-width:0;max-width:100%;white-space:nowrap}.fs-dock-button span{overflow:hidden;text-overflow:ellipsis}.fs-dock-button:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}.fs-dock-button[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}.fs-dialog{position:fixed;z-index:1100;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,8px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,0 6px 24px #0002);padding:16px;overflow:auto}.fs-dialog h3{margin:0;font-size:14px;font-weight:500}.fs-dialog .fs-head{flex-wrap:nowrap}.fs-dialog .fs-events{margin-top:8px}.fs-dialog .fs-event:last-child{border-bottom:0}.fs-dialog .fs-stats{margin-top:14px}.fs-dialog .fs-stat{padding:8px}.fs-dialog .fs-stat:first-child{padding-left:0}.fs-dialog .fs-stat dd{font-size:18px;line-height:24px}.fs-dialog .fs-fact{font-size:12px;gap:12px}
      .fs-toast{position:fixed;right:20px;bottom:20px;z-index:1000;width:min(360px,calc(100vw - 40px));padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,8px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,0 6px 24px #0002)}.fs-toast p{margin:5px 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}.fs-summary{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
      .fs-root button:focus-visible,.fs-dock-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.fs-icon{display:inline-flex;flex:none;position:relative}.fs-icon .fs-dot{position:absolute;right:0;top:0;border:1px solid var(--dsw-alias-bg-base)}
      @media(max-width:560px){.fs-root{padding:20px 16px 28px}.fs-page{gap:24px}.fs-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.fs-stat:nth-child(3){border-left:0;padding-left:0}.fs-stat:nth-child(n+3){border-top:.5px solid var(--dsw-alias-border-l2)}.fs-head{align-items:flex-start}.fs-tools{width:100%}.fs-event-head{flex-wrap:wrap;gap:2px}.fs-fact{gap:12px}.fs-dialog .fs-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .fs-dialog,.fs-toast{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 6px 24px #0002)}
      .fs-conversations{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}.fs-conversation{padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.fs-conversation-main{min-width:0;flex:1}.fs-conversation-title{font-weight:500;margin-bottom:5px}.fs-live{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.fs-event-context{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}.fs-link{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;padding:0;text-align:left;cursor:pointer}.fs-link:disabled{color:var(--dsw-alias-label-secondary);cursor:default}.fs-health-note{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
      @media(max-width:560px){.fs-conversation{flex-direction:column}.fs-conversation-main{width:100%}.fs-conversation .fs-tools{width:auto}}
    `;
    const labels = {
      'correction-deferred': ['等待纠正', '当前回合结束后提交纠正；本次输出未中断。'],
      'recovery-submitted': ['已提交纠正', '已开启独立纠正回合，恢复效果待确认。'],
      'budget-exhausted': ['纠正次数已用完', '已达到本任务的纠正上限，没有追加模型请求。'],
      'user-input-takes-priority': ['已取消待执行纠正', '用户输入优先，没有追加纠正回合。'],
      'intervention-unavailable': ['纠正不可用', '当前宿主或模式不支持该动作，未中断输出。'],
      'recovery-failed': ['纠正提交失败', '没有确认纠正成功，请检查当前对话。'],
      'cancel-requested': ['已请求中断', '已向宿主请求停止本次重复响应；不等于宿主已确认停止。'],
      'stop-confirmed': ['已停止重复生成', '宿主已记录本轮因防护而停止；未自动重试或重放工具。'],
      'stop-unconfirmed': ['停止结果未确认', '已结束跟踪，但没有收到属于本插件的停止确认。'],
      'stop-failed': ['停止请求失败', '宿主未接受停止请求，请检查当前对话。'],
      'correction-revoked': ['已撤销纠正', '监控关闭、请求中止或会话结束，待执行纠正已撤销。'],
    };
    const time = value => value ? new Date(value).toLocaleString() : '尚无';
    const modeName = mode => mode === 'guard' ? '防护停止' : mode === 'assist' ? '有限纠正' : '仅观察';
    function health(data) {
      if (data.tracked === false) return { label: '仅保留历史记录', tone: 'off' };
      const excluded = { paused: '监控已暂停', disabled: '此对话未启用', 'other-model': '当前模型不在监控范围', auxiliary: '辅助请求未监控', unavailable: '检测不完整 · 待下次请求', waiting: '待下次 Flash 请求' };
      const live = data.live, latest = data.latestEvent;
      if (data.coverage === 'unavailable' && latest?.kind === 'recovery' && ['cancel-requested', 'stop-confirmed', 'stop-unconfirmed', 'stop-failed'].includes(latest.action)) return { label: labels[latest.action][0], tone: 'warn' };
      if (excluded[data.coverage]) return { label: excluded[data.coverage], tone: 'off' };
      if (latest?.kind === 'recovery') return { label: labels[latest.action]?.[0] || '处理状态已更新', tone: 'warn' };
      if (live?.risk === 'confirmed' || (!live && latest?.kind === 'stream-repeat' && latest.confirmed)) return { label: '确认重复 · 未中断', tone: 'warn' };
      if (live?.risk === 'suspected' || (!live && latest?.kind === 'stream-repeat')) return { label: '疑似重复 · 观察中', tone: 'warn' };
      if (live?.incomplete) return { label: '检测不完整 · 内容块超限', tone: 'off' };
      if (live?.active && live.silentForMs >= 30000) return { label: '等待输出 · 尚不能判断', tone: 'warn' };
      if (latest?.kind === 'tool-repeat') return { label: '工具重复 · 仅提醒', tone: 'warn' };
      if (data.coverage === 'monitoring') return { label: !live ? '正在监控' : live.checks ? '持续检测 · 暂未发现循环' : live.reasoningChars + live.textChars ? '接收输出 · 积累检测样本' : '等待模型首个输出', tone: 'on' };
      return { label: live && !live.checks ? '请求结束 · 检测样本不足' : '最近请求 · 未发现重复', tone: live && !live.checks ? 'off' : 'on' };
    }
    function explain(event, mode) {
      if (event.kind === 'stream-repeat') return {
        title: event.confirmed ? `确认${event.contentType === 'text' ? '正文' : event.contentType === 'reasoning' ? '推理' : '输出'}重复` : '疑似重复',
        reason: `检测到${event.method === 'phrase' ? '夹杂变化文字的短句反复出现' : '周期性短句轮转'}${event.period ? `，周期 ${event.period} 字符` : ''}${event.repeats ? `、重复 ${event.repeats} 次` : ''}${event.coverage === undefined ? '' : `，${event.method === 'phrase' ? '短句单元占比' : '窗口覆盖'} ${Math.round(event.coverage * 100)}%`}${event.novelty === undefined ? '' : `，新增四字符片段 ${Math.round(event.novelty * 100)}%`}。${event.confirmed ? '连续多次检查通过重复确认。' : '尚未达到连续确认条件。'}`,
        result: event.confirmed && mode === 'guard' && event.contentType === 'reasoning' ? '已确认推理重复；停止请求和宿主确认见后续处理记录。'
          : event.confirmed && mode === 'assist' ? '仅确认重复；纠正是否排队或提交见后续处理记录。本次输出未中断。' : '仅告警，未拦截、未中断输出。',
      };
      if (event.kind === 'tool-repeat') return { title: '工具重复告警', reason: `相同工具、参数及结果${event.repeats ? `连续出现 ${event.repeats} 次` : '重复出现'}，可能没有新增进展。`, result: '仅提醒，未阻止、跳过或重放任何工具。' };
      if (event.kind === 'recovery') return { title: labels[event.action]?.[0] || '纠正状态变更', reason: '此前检测到连续重复推理或正文。', result: labels[event.action]?.[1] || '请查看后续记录确认实际处理结果。' };
      return { title: event.kind === 'internal-error' ? '监控异常' : '监控已启动', reason: '', result: event.kind === 'internal-error' ? '当前检测可能不完整，模型输出继续传递。' : '观察模式已就绪。' };
    }
    function createController(ctx) {
      let state = { data: null, conversations: [], conversationError: '', sessions: Object.create(null), sessionErrors: Object.create(null), error: '', busy: false, test: '', toast: null, updatedAt: null };
      const listeners = new Set(), requests = new Set(), downloads = new Map(), watched = new Map(), pendingSessions = new Set();
      let disposed = false, polling = false, listing = false, generation = 0, lastNotice = '';
      const publish = patch => { if (!disposed) { state = { ...state, ...patch }; for (const fn of listeners) fn(); } };
      async function call(endpoint, payload = {}) {
        const controller = new AbortController(); requests.add(controller);
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const result = await ctx.connection.rpc.call('/flash-stabilizer', endpoint, payload, controller.signal);
          if (!result?.ok) throw new Error('Host operation unavailable');
          return result.value;
        } finally { clearTimeout(timer); requests.delete(controller); }
      }
      function accept(data) {
        const event = data.events.find(e => (e.kind === 'stream-repeat' && e.confirmed) || (e.kind === 'recovery' && e.action === 'recovery-submitted'));
        const id = event ? `${event.session}/${event.time}/${event.kind}/${event.action || ''}` : '';
        const patch = { data, error: '', updatedAt: new Date().toISOString() };
        if (id && id !== lastNotice) { patch.toast = event; lastNotice = id; }
        publish(patch);
      }
      async function refreshSession(id) {
        if (disposed || pendingSessions.has(id)) return;
        const current = generation; pendingSessions.add(id);
        try {
          const value = await call('session', { sessionId: id });
          if (generation === current && watched.has(id)) publish({ sessions: { ...state.sessions, [id]: value }, sessionErrors: { ...state.sessionErrors, [id]: '' } });
        } catch { if (generation === current && watched.has(id)) publish({ sessionErrors: { ...state.sessionErrors, [id]: '会话监控未连接' } }); }
        finally { pendingSessions.delete(id); }
      }
      async function refresh() {
        if (polling || disposed || state.busy) return;
        polling = true; const current = generation;
        try { const data = await call('snapshot'); if (generation === current) accept(data); }
        catch { if (generation === current) publish({ error: '监控服务未连接' }); }
        finally { polling = false; }
      }
      async function refreshConversations() {
        if (disposed || listing || state.busy) return;
        listing = true; const current = generation;
        try { const value = await call('conversations'); if (generation === current) publish({ conversations: Array.isArray(value) ? value : [], conversationError: '' }); }
        catch { if (generation === current) publish({ conversationError: '对话列表未连接，请刷新重试。' }); }
        finally { listing = false; }
      }
      async function poll() { await Promise.all([refresh(), refreshConversations(), ...[...watched.keys()].map(refreshSession)]); }
      async function action(endpoint, payload) {
        if (state.busy || disposed) return;
        generation++; publish({ busy: true, error: '' });
        try {
          const value = await call(endpoint, payload);
          if (disposed) return;
          if (endpoint === 'setMonitoring') accept(value);
          if (endpoint === 'selfTest') publish({ test: value.passed && value.modelRequests === 0 ? '离线自检通过，未调用模型，未计入真实告警。' : '离线自检未通过。' });
          if (endpoint === 'export') {
            const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
            if (downloads.size >= 10) { const [old, timer] = downloads.entries().next().value; clearTimeout(timer); URL.revokeObjectURL(old); downloads.delete(old); }
            downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
            const a = document.createElement('a'); a.href = url; a.download = 'flash-stabilizer-diagnostics.json'; document.body.appendChild(a); a.click(); a.remove();
          }
        } catch { publish({ error: '操作未完成，请重试。' }); }
        finally { generation++; publish({ busy: false }); refreshConversations(); for (const id of watched.keys()) refreshSession(id); }
      }
      const timer = setInterval(poll, 2000); poll();
      return {
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, snapshot: () => state, refresh: poll, action,
        watch: id => { watched.set(id, (watched.get(id) || 0) + 1); refreshSession(id); return () => { const count = watched.get(id) - 1; if (count) watched.set(id, count); else { watched.delete(id); const { [id]: _old, ...sessions } = state.sessions; const { [id]: _error, ...sessionErrors } = state.sessionErrors; publish({ sessions, sessionErrors }); } }; },
        dismiss: () => publish({ toast: null }),
        dispose: () => { disposed = true; clearInterval(timer); for (const request of requests) request.abort(); for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear(); watched.clear(); listeners.clear(); },
      };
    }
    function apply(ctx) {
      const tag = document.createElement('style'); tag.dataset.pluginCss = 'dsh-flash-stabilizer'; tag.textContent = css; document.head.appendChild(tag);
      const controller = createController(ctx); ctx.effect(() => () => { controller.dispose(); tag.remove(); });
      const useState = () => React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
      const icon = (Component, size = 14) => Component ? h(Component, { size, 'aria-hidden': true }) : null;
      const command = (label, onClick, Icon, disabled, onlyIcon = false) => h(UI.Button, { type: 'button', variant: 'ghost', size: 'sm', className: onlyIcon ? 'fs-icon-button' : 'fs-action', title: label, 'aria-label': label, onClick, disabled, icon: icon(Icon) }, onlyIcon ? null : label);
      const status = (text, tone = 'on') => h('span', { className: 'fs-state', 'data-tone': tone }, h('i', { className: 'fs-dot', 'aria-hidden': true }), text);
      const stat = (label, value) => h('div', { className: 'fs-stat', key: label }, h('dt', null, label), h('dd', null, value));
      const fact = (label, value) => h('div', { className: 'fs-fact', key: label }, h('dt', null, label), h('dd', null, value));
      const service = name => ctx.get?.(name) ?? ctx[name];
      function conversationName(item) {
        const row = service('sessions')?.list?.getSnapshot?.().byId?.[item.sessionId];
        const title = typeof row?.title === 'string' && row.title.trim() ? row.title : null;
        return title ? `${title} · ${item.sessionKey.slice(0, 6)}` : `对话 ${item.sessionKey.slice(0, 8)}`;
      }
      const openConversation = item => service('uiWorkspace')?.openSession?.(item.sessionId);
      function Live({ data }) {
        const live = data.live;
        return h(React.Fragment, null,
          h('div', { className: 'fs-live' }, h('span', null, `第 ${live?.turn ?? data.turn ?? 0} 轮 · 步骤 ${live?.step ?? data.step ?? 0}`),
            live && h('span', null, `推理 ${live.reasoningChars.toLocaleString()} 字符`), live && h('span', null, `正文 ${live.textChars.toLocaleString()} 字符`),
            live && h('span', null, `已检查 ${live.checks} 次`), live && h('span', null, `检测文本 ${live.analyzedChars ?? 0} 字符`), h('span', null, `工具结果 ${data.toolResults ?? 0} 次`)),
          live && h('div', { className: 'fs-live' }, h('span', null, `最近输出 ${time(live.lastOutputAt)}`),
            h('span', null, `最近检测 ${time(live.lastCheckAt)}`), live.active && h('span', null, `等待新输出 ${Math.floor(live.silentForMs / 1000)} 秒`)));
      }
      function Events({ events, mode, conversations = [] }) {
        return h('ol', { className: 'fs-events' }, events.map((event, i) => {
          const text = explain(event, mode);
          return h('li', { className: 'fs-event', key: `${event.session}/${event.time}/${i}` },
            h('div', { className: 'fs-event-head' }, h('span', { className: 'fs-event-title' }, text.title), h('time', null, time(event.time))),
            h('div', { className: 'fs-event-context' }, event.session && (() => { const item = conversations.find(item => item.sessionKey === event.session); return h('button', { type: 'button', className: 'fs-link', disabled: !item || !service('uiWorkspace')?.openSession, onClick: () => openConversation(item) }, item ? conversationName(item) : `对话 ${event.session.slice(0, 8)}`); })(),
              event.turn !== undefined && h('span', { className: 'fs-tag' }, `第 ${event.turn} 轮${event.step === undefined ? '' : ` · 步骤 ${event.step}`}`)),
            text.reason && h('p', null, text.reason), h('p', { className: 'fs-result' }, text.result));
        }));
      }
      function Panel({ view } = {}) {
        const state = useState(), data = state.data, online = data && !state.error;
        const [filter, setFilter] = React.useState('');
        React.useEffect(() => service('sessions')?.list?.subscribe?.(() => controller.refresh()), []);
        const label = !online ? (state.error || '连接中') : data.monitoring ? '监控在线' : '监控已暂停';
        if (view === 'summary') return h('div', { className: 'fs-summary' }, status(label, online && data.monitoring ? 'on' : 'off'), data && `已监控 ${data.monitoredRequests} 次 · 确认重复 ${data.confirmed} 次`);
        const events = data?.events.filter(e => e.kind !== 'compatibility' && (!filter || e.session === filter)) || [];
        return h('section', { className: 'fs-root', 'aria-label': 'Flash 防空转监控面板' }, h('div', { className: 'fs-page' },
          h('header', { className: 'fs-head' }, h('div', null, h('h2', null, 'Flash 防空转'), h('p', { className: 'fs-sub' }, 'DeepSeek Flash · 检测与处理记录')),
            h('div', { className: 'fs-tools' }, h('span', { className: 'fs-switch' }, '启用监控', h(UI.Switch, { label: '启用监控', checked: Boolean(data?.monitoring), disabled: !online || state.busy, onChange: enabled => controller.action('setMonitoring', { enabled }) })),
              command('刷新状态', controller.refresh, UI.IconRefreshOutlineRegular, state.busy, true), command('离线自检', () => controller.action('selfTest'), UI.IconInfoOutlineRegular, !online || state.busy), command('导出诊断日志', () => controller.action('export'), UI.IconDownloadOutlineRegular, !online || state.busy, true))),
          state.error && h('p', { role: 'alert', className: 'fs-error' }, state.error), state.test && h('p', { role: 'status', className: 'fs-test' }, state.test),
          data && h(React.Fragment, null,
            h('dl', { className: 'fs-stats' }, stat('已监控请求', data.monitoredRequests), stat('当前请求', data.activeRequests), stat('确认重复', data.confirmed), stat('已提交纠正', data.recoverySubmitted)),
            h('section', { className: 'fs-section' }, h('div', { className: 'fs-section-head' }, h('h3', null, '运行状态'), status(label, online && data.monitoring ? 'on' : 'off')),
              h('dl', { className: 'fs-facts' }, fact('处理模式', modeName(data.mode)), fact('检测后动作', data.mode === 'guard' ? '确认推理重复后请求停止本轮' : data.mode === 'assist' ? '回合结束后可提交纠正' : '显示告警，不中断输出'), fact('最近监控', time(data.lastMonitoredAt)), fact('磁盘日志', !data.logging.enabled ? '未开启' : data.logging.healthy ? '写入正常' : '写入失败'))),
            h('section', { className: 'fs-section', 'aria-label': '逐对话实时监控' }, h('div', { className: 'fs-section-head' }, h('h3', null, '对话实时监控'), h('span', { className: 'fs-muted' }, '每 2 秒同步')),
              (state.error || state.conversationError) && h('p', { className: 'fs-error' }, '连接中断，以下为上次同步数据，不能判断当前模型状态。'),
              h('div', { className: 'fs-conversations' }, state.conversations.length ? state.conversations.map(item => { const current = state.error || state.conversationError ? { label: '状态已过期 · 等待重新连接', tone: 'off' } : health(item); return h('article', { className: 'fs-conversation', key: item.sessionKey },
                h('div', { className: 'fs-conversation-main' }, h('div', { className: 'fs-conversation-title' }, conversationName(item)), status(current.label, current.tone), h(Live, { data: item }),
                  h('div', { className: 'fs-live' }, `${item.counterScope === 'retained-events' ? '保留事件中' : '累计'}确认重复 ${item.confirmed} 次 · 已提交纠正 ${item.recoverySubmitted} 次 · ${item.cancelRequested ? `请求中断 ${item.cancelRequested} 次` : '未拦截、未中断'}`), !item.tracked && h('p', { className: 'fs-muted' }, '会话已不在实时跟踪中，仅显示保留事件。')),
                h('div', { className: 'fs-tools' }, command('查看此对话记录', () => setFilter(item.sessionKey), UI.IconInfoOutlineRegular, false), command('打开对话', () => openConversation(item), null, !service('uiWorkspace')?.openSession))); }) : h('div', { className: 'fs-empty' }, '尚无已跟踪的对话；下一次匹配的模型请求开始后自动显示。')),
              h('p', { className: 'fs-health-note' }, '实时观察已收到的输出；“暂未发现循环”不保证后续不会重复，也不代表任务结果正确。长时间没有输出不直接判定为低熵循环。')),
            h('section', { className: 'fs-section' }, h('div', { className: 'fs-section-head' }, h('h3', null, '检测与处理'), h('span', { className: 'fs-muted' }, `${events.length} 条记录`)),
              filter && command('显示全部对话', () => setFilter(''), UI.IconCloseOutlineRegular, false),
              events.length ? h(Events, { events, mode: data.mode, conversations: state.conversations }) : h('div', { className: 'fs-empty' }, '尚无检测记录'), h('p', { className: 'fs-note' }, '显示发生在哪个对话、第几轮、推理或正文的重复特征、原因和实际动作。不保存推理正文、工具参数或命令；导出不包含对话名称和原始 ID。'))),
          h('footer', { className: 'fs-muted' }, `最近同步 ${time(state.updatedAt)}`)));
      }
      function SessionStatus({ sessionId }) {
        const state = useState(), data = state.sessions[sessionId], error = state.sessionErrors[sessionId];
        const [open, setOpen] = React.useState(false), [position, setPosition] = React.useState({});
        const anchor = React.useRef(null), dialog = React.useRef(null), dialogId = React.useId();
        React.useEffect(() => controller.watch(sessionId), [sessionId]);
        React.useEffect(() => { setOpen(false); }, [sessionId]);
        React.useLayoutEffect(() => {
          if (!open) return;
          const place = () => {
            const rect = anchor.current.getBoundingClientRect(), width = Math.min(420, window.innerWidth - 24);
            const above = rect.top - 20, below = window.innerHeight - rect.bottom - 20;
            setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
              ...(above >= below ? { bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(0, above) }
                : { top: rect.bottom + 8, maxHeight: Math.max(0, below) }) });
          };
          const close = event => { if (event.type === 'keydown' && event.key !== 'Escape') return; if (event.type === 'pointerdown' && (dialog.current?.contains(event.target) || anchor.current?.contains(event.target))) return; setOpen(false); if (event.type === 'keydown') anchor.current?.focus(); };
          place(); document.addEventListener('keydown', close); document.addEventListener('pointerdown', close); window.addEventListener('resize', place);
          return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); window.removeEventListener('resize', place); };
        }, [open]);
        let label = '连接中', tone = 'off';
        if (error) label = '监控未连接';
        else if (data) ({ label, tone } = health(data));
        return h('div', { className: 'fs-dock', 'data-composer-stat': 'flash-stabilizer' },
          h('button', { type: 'button', className: 'fs-dock-button', ref: anchor, 'data-tone': tone, title: 'Flash 防空转：' + label, 'aria-label': 'Flash 防空转：' + label, 'aria-expanded': open, 'aria-controls': open ? dialogId : undefined, 'aria-haspopup': 'dialog', onClick: () => setOpen(value => !value) }, icon(tone === 'warn' ? UI.IconWarningOutlineRegular : UI.IconShieldOutlineRegular, 12), h('span', { role: 'status' }, 'Flash · ' + label)),
          open && createPortal(h('section', { id: dialogId, role: 'dialog', 'aria-label': '此对话的防空转记录', className: 'fs-dialog', ref: dialog, style: position },
            h('div', { className: 'fs-head' }, h('h3', null, '此对话 · Flash 防空转'), command('关闭', () => { setOpen(false); anchor.current?.focus(); }, UI.IconCloseOutlineRegular, false, true)),
            error ? h('p', { className: 'fs-error' }, error) : data && h(React.Fragment, null,
              h('p', { className: 'fs-muted' }, label), h('dl', { className: 'fs-stats' }, stat('已监控', data.monitoredRequests), stat('确认重复', data.confirmed), stat('请求中断', data.cancelRequested), stat('已提交纠正', data.recoverySubmitted)),
              h(Live, { data }),
              h('dl', { className: 'fs-facts' }, fact('模式', modeName(data.mode)), fact('拦截动作', data.cancelRequested ? `已请求中断 ${data.cancelRequested} 次，需以宿主结果为准` : '无，未中断模型或工具'), fact('最近监控', time(data.lastMonitoredAt))),
              data.events.length ? h(Events, { events: data.events, mode: data.mode }) : h('p', { className: 'fs-muted' }, data.coverage === 'checked' ? '最近已检查的输出中未发现符合规则的重复。' : '尚无检测事件。'),
              h('p', { className: 'fs-note' }, '每 2 秒同步。暂未发现循环只描述已收到的输出，不能保证后续不会重复。计数在重新跟踪或插件重载后重置；详情取自全局最近 100 条事件。'))), document.body));
      }
      function Icon() {
        const { data, error } = useState();
        return h('span', { className: 'fs-icon', title: error || `Flash 防空转 · ${data?.monitoring ? '在线' : '暂停'}` }, icon(UI.IconShieldOutlineRegular, 20), h('i', { className: 'fs-dot', style: { background: error || data?.confirmed ? 'var(--dsw-alias-state-warn-primary)' : undefined } }));
      }
      function Toast() {
        const { toast, data } = useState(); if (!toast) return null;
        const text = explain(toast, data?.mode);
        return h('aside', { className: 'fs-toast', role: 'alert' }, h('strong', null, 'Flash · ' + text.title), h('p', null, text.result), h('div', { className: 'fs-row' }, command('查看记录', () => { ctx.layout.selectPanel(PANEL); controller.dismiss(); }, UI.IconInfoOutlineRegular), command('关闭', controller.dismiss, UI.IconCloseOutlineRegular, false, true)));
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 20, label: () => 'Flash 防空转' }, Icon));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-flash-stabilizer' }, Panel));
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-flash-stabilizer#flash-stabilizer' }, Panel));
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'flash-stabilizer', order: 2, inject: sessionId => ({ sessionId }) }, SessionStatus));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'flash-stabilizer.alert' }, Toast));
    }
    return { inject: ['slots', 'connection', 'layout'], apply };
  },
});
