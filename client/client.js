// Native Harness module. React and the authenticated connection belong to the shell.
window.__ModuleLoader__.load({
  id: 'dsh-flash-stabilizer',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const PANEL = 'flash-stabilizer';
    const labels = {
      'correction-deferred': '已等待本回合结束，再发起纠正',
      'recovery-submitted': '已提交纠正回合（效果待确认）',
      'budget-exhausted': '已达到本任务的纠正次数上限',
      'user-input-takes-priority': '用户输入优先，已取消纠正',
      'intervention-unavailable': '当前宿主无法执行纠正',
      'recovery-failed': '纠正提交失败',
      'cancel-requested': '已请求停止重复响应',
    };
    const time = value => value ? new Date(value).toLocaleString() : '尚无';
    function describe(event) {
      if (event.kind === 'stream-repeat') return event.confirmed ? '已确认推理 / 文本重复' : '疑似重复，继续观察';
      if (event.kind === 'tool-repeat') return '工具重复告警（仅观察）';
      if (event.kind === 'recovery') return labels[event.action] || '纠正状态变更';
      if (event.kind === 'internal-error') return '监控内部异常';
      if (event.kind === 'compatibility') return '监控已启动';
      return '诊断记录';
    }
    const style = {
      panel: { padding: '24px', maxWidth: '1000px', margin: '0 auto', color: 'inherit', lineHeight: 1.6, overflowWrap: 'anywhere' },
      card: { border: '1px solid rgba(128,128,128,.28)', borderRadius: '8px', padding: '16px', background: 'rgba(128,128,128,.05)' },
      row: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' },
      button: { color: 'inherit', background: 'rgba(128,128,128,.12)', border: '1px solid rgba(128,128,128,.35)', borderRadius: '7px', padding: '7px 13px', cursor: 'pointer', font: 'inherit' },
      muted: { opacity: .72, fontSize: '13px' },
    };
    function createController(ctx) {
      let state = { data: null, error: '', busy: false, test: '', toast: null, updatedAt: null };
      const listeners = new Set(), requests = new Set(), downloads = new Map();
      let disposed = false, polling = false, generation = 0, lastNotice = '';
      const publish = patch => {
        if (disposed) return;
        state = { ...state, ...patch };
        for (const fn of listeners) fn();
      };
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
        const id = event ? `${event.time}/${event.kind}/${event.action || ''}` : '';
        const patch = { data, error: '', updatedAt: new Date().toISOString() };
        if (id && id !== lastNotice) { patch.toast = event; lastNotice = id; }
        publish(patch);
      }
      async function refresh() {
        if (polling || disposed || state.busy) return;
        polling = true;
        const current = generation;
        try { const data = await call('snapshot'); if (generation === current) accept(data); }
        catch { if (generation === current) publish({ error: '无法连接监控服务，请刷新页面或检查插件是否启用。' }); }
        finally { polling = false; }
      }
      async function action(endpoint, payload) {
        if (state.busy || disposed) return;
        generation++; publish({ busy: true, error: '' });
        try {
          const value = await call(endpoint, payload);
          if (disposed) return;
          if (endpoint === 'setMonitoring') accept(value);
          if (endpoint === 'selfTest') publish({ test: value.passed && value.modelRequests === 0
            ? '离线自检通过：检测器已识别测试重复；未调用模型，未计入真实告警。'
            : '离线自检未通过，请导出诊断日志。' });
          if (endpoint === 'export') {
            const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
            if (downloads.size >= 10) {
              const [old, timer] = downloads.entries().next().value;
              clearTimeout(timer); URL.revokeObjectURL(old); downloads.delete(old);
            }
            downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
            const a = document.createElement('a'); a.href = url; a.download = 'flash-stabilizer-diagnostics.json';
            document.body.appendChild(a); a.click(); a.remove();
          }
        } catch { publish({ error: '操作未完成，请检查连接后重试。' }); }
        finally { generation++; publish({ busy: false }); }
      }
      const timer = setInterval(refresh, 3000);
      refresh();
      return {
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        snapshot: () => state, refresh, action, dismiss: () => publish({ toast: null }),
        dispose: () => { disposed = true; clearInterval(timer); for (const request of requests) request.abort(); for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); } downloads.clear(); listeners.clear(); },
      };
    }
    function apply(ctx) {
      const controller = createController(ctx);
      ctx.effect(() => () => controller.dispose());
      const useState = () => React.useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
      const button = (label, onClick, disabled = false) => h('button', { type: 'button', style: style.button, onClick, disabled }, label);
      function Panel({ view } = {}) {
        const state = useState(), data = state.data;
        const online = data && !state.error;
        const status = !online ? (state.error ? '监控服务未连接' : '正在连接监控服务…') : data.monitoring ? '监控在线' : '监控已暂停';
        const color = !online ? '#c27c38' : data.monitoring ? '#329d79' : '#b38b3d';
        if (view === 'summary') {
          return h('div', { style: style.row },
            h('span', { style: { color } }, status),
            data && h('span', { style: style.muted }, `已监控 ${data.monitoredRequests} 次 · 已确认重复 ${data.confirmed} 次`));
        }
        const stat = (label, value) => h('div', { key: label, style: { ...style.card, flex: '1 1 140px' } },
          h('div', { style: style.muted }, label), h('strong', { style: { fontSize: '25px' } }, value));
        return h('section', { style: style.panel, 'aria-label': 'Flash 防空转监控面板' },
          h('div', { style: { ...style.row, justifyContent: 'space-between' } },
            h('h2', { style: { margin: '0 0 8px', fontSize: '22px' } }, 'Flash 防空转'),
            h('strong', { role: 'status', style: { color } }, `● ${status}`)),
          h('p', { style: style.muted }, '查看插件是否正在监控，以及每次检测后实际采取的动作。统计从本次插件加载开始，刷新页面不会清零。'),
          h('div', { style: style.row },
            button('刷新状态', controller.refresh, state.busy),
            button(data?.monitoring ? '暂停监控' : '继续监控', () => controller.action('setMonitoring', { enabled: !data.monitoring }), !online || state.busy),
            button('离线自检', () => controller.action('selfTest'), !online || state.busy),
            button('导出诊断日志', () => controller.action('export'), !online || state.busy)),
          state.error && h('p', { role: 'alert' }, state.error),
          state.test && h('p', { role: 'status' }, state.test),
          data && h(React.Fragment, null,
            h('p', { style: style.muted }, `模式：${data.mode === 'assist' ? '有限纠正' : '观察告警'} · 最近同步：${time(state.updatedAt)}`),
            h('div', { style: style.row },
              stat('已监控请求', data.monitoredRequests), stat('正在监控', data.activeRequests),
              stat('已确认重复', data.confirmed), stat('已提交纠正', data.recoverySubmitted)),
            h('p', { style: style.muted }, `最近监控请求：${time(data.lastMonitoredAt)}。仅匹配配置中的 Flash 模型；暂停后恢复从下一次请求开始。暂停仅本次插件运行有效。`),
            h('div', { style: style.card },
              h('strong', null, data.mode === 'assist' ? '检测后等待本回合结束，最多提交两次纠正' : '观察模式：检测后显示告警'),
              h('div', { style: style.muted }, '持续空转的响应不会被此模式自动中断；“纠正已提交”表示请求已发送，效果仍需确认。'),
              h('div', { style: style.muted }, `磁盘日志：${!data.logging.enabled ? '未开启' : data.logging.healthy ? '写入正常' : '写入失败'} · 内存保留最近 ${data.logging.limit} 条去标识记录，可直接导出。`)),
            h('h3', null, '最近检测与处理记录'),
            h('div', { style: style.muted }, '不保存推理正文、工具参数或命令；风险分数不代表发生概率。'),
            !data.events.some(e => e.kind !== 'compatibility') && h('p', null, '尚未发现重复。可点击“离线自检”验证检测器是否工作。'),
            h('ol', { style: { padding: 0, listStyle: 'none' } }, data.events.map((event, i) =>
              h('li', { key: `${event.time}-${i}`, style: { ...style.card, marginTop: '8px', borderLeft: `3px solid ${event.confirmed ? '#d58a38' : '#71938a'}` } },
                h('strong', null, describe(event)),
                h('div', { style: style.muted }, `${time(event.time)}${event.session ? ` · 会话 ${event.session.slice(0, 8)}` : ''}${event.score ? ` · 风险分数 ${event.score}` : ''}${event.chars ? ` · 已分析 ${event.chars} 字符` : ''}`))))));
      }
      function Icon() {
        const { data, error } = useState();
        return h('span', { title: error ? '监控连接失败' : `Flash 防空转 · ${data?.monitoring ? '在线' : '暂停'} · 已确认 ${data?.confirmed || 0}`, style: { position: 'relative', display: 'inline-flex' } },
          h('svg', { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-label': 'Flash 防空转' },
            h('path', { d: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z' }), h('path', { d: 'm13 7-4 6h4l-2 4' })),
          h('span', { style: { position: 'absolute', right: -2, top: -2, width: 7, height: 7, borderRadius: '50%', background: error ? '#c27c38' : data?.confirmed ? '#d58a38' : data?.monitoring ? '#329d79' : '#999' } }));
      }
      function Toast() {
        const { toast } = useState();
        if (!toast) return null;
        return h('aside', { role: 'alert', style: { ...style.card, position: 'fixed', right: 24, bottom: 24, width: 'calc(100vw - 48px)', maxWidth: 360, boxSizing: 'border-box', zIndex: 1000, color: 'CanvasText', background: 'Canvas', boxShadow: '0 8px 30px #0003' } },
          h('strong', null, `Flash 防空转：${describe(toast)}`),
          h('div', { style: { ...style.row, marginTop: 10 } },
            button('查看记录', () => { ctx.layout.selectPanel(PANEL); controller.dismiss(); }), button('关闭', controller.dismiss)));
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Panel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 20, label: () => 'Flash 防空转' }, Icon));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-flash-stabilizer' }, Panel));
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-flash-stabilizer#flash-stabilizer' }, Panel));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'flash-stabilizer.alert' }, Toast));
    }
    return { inject: ['slots', 'connection', 'layout'], apply };
  },
});
