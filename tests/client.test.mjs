import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
import { createPortal } from 'react-dom';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

let dom, root, cleanup;
const baseline = () => ({ monitoring: true, mode: 'observe', monitoredRequests: 3, activeRequests: 0,
  confirmed: 0, recoverySubmitted: 0, lastMonitoredAt: '2026-11-11T11:00:00Z', counts: {}, events: [], logging: { enabled: false, healthy: true, limit: 100 } });
beforeEach(() => {
  vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://harness.local/' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.querySelector('#root'));
  cleanup = [];
});
afterEach(async () => { await act(async () => { root.unmount(); for (const fn of cleanup) fn(); }); dom.window.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function mount(call, sessionId, services = {}) {
  let plugin;
  const slots = [];
  const url = { createObjectURL: vi.fn(() => 'blob:diagnostic'), revokeObjectURL: vi.fn() };
  runInNewContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), {
    window: Object.assign(dom.window, { __ModuleLoader__: { load: value => { plugin = value.factory(name => {
      if (name === 'react') return React;
      if (name === 'react-dom') return { createPortal };
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
        Button: ({ icon, children, variant: _variant, size: _size, ...props }) => React.createElement('button', props, icon, children),
        Switch: ({ label, checked, onChange, disabled }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled, onClick: () => onChange(!checked) }),
      };
      throw Error('Unexpected module ' + name);
    }); } } }),
    document, URL: url, Blob, AbortController, setInterval, clearInterval, setTimeout, clearTimeout,
  });
  const selectPanel = vi.fn();
  await act(async () => {
    plugin.apply({ connection: { rpc: { call } }, layout: { selectPanel }, get: name => services[name], effect: fn => cleanup.push(fn()),
      slots: { inject: (_name, fn) => fn(), register: (meta, component) => slots.push({ meta, component }) } });
    const Panel = slots.find(s => s.meta.name === 'main').component;
    const Toast = slots.find(s => s.meta.name === 'shell.overlay').component;
    const Dock = slots.find(s => s.meta.name === 'conversation.composer.dock').component;
    root.render(sessionId ? React.createElement(Dock, { sessionId }) : React.createElement(React.Fragment, null, React.createElement(Panel), React.createElement(Toast)));
  });
  return { slots, url, selectPanel };
}
const button = text => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text || b.textContent === text);
it('links to the repository and exposes persistent automatic and manual update controls', async () => {
  const update = { repository: 'https://github.com/MyRemme/dsh-flash-stabilizer', currentVersion: '0.1.7', latestVersion: '0.1.8', available: true, automatic: false, phase: 'available' };
  const call = vi.fn(async (_channel, method, payload) => {
    if (method === 'setAutomaticUpdates') update.automatic = payload.enabled;
    if (method === 'installUpdate') update.phase = 'waiting-idle';
    return { ok: true, value: method === 'conversations' ? [] : ['updates', 'setAutomaticUpdates', 'checkUpdates', 'installUpdate'].includes(method) ? { ...update } : baseline() };
  });
  await mount(call);
  expect(document.querySelector('a[title="打开 GitHub 仓库"]').href).toBe(update.repository);
  expect(document.body.textContent).toContain('0.1.7'); expect(document.body.textContent).toContain('有新版本');
  await act(async () => { button('自动更新').click(); }); expect(update.automatic).toBe(true);
  await act(async () => { button('检查更新').click(); }); expect(call).toHaveBeenCalledWith('/flash-stabilizer', 'checkUpdates', {}, expect.anything());
  await act(async () => { button('安装更新').click(); }); expect(document.body.textContent).toContain('等待所有对话空闲后安装');
});
it('registers discoverable native entries and renders actual monitoring state with working controls', async () => {
  const data = baseline();
  const call = vi.fn(async (_channel, method, payload) => {
    if (method === 'setMonitoring') data.monitoring = payload.enabled;
    return { ok: true, value: method === 'selfTest' ? { passed: true, modelRequests: 0 } : structuredClone(data) };
  });
  const { slots } = await mount(call);
  expect(slots.map(s => s.meta.name)).toEqual(expect.arrayContaining(['sidebar.panellist', 'plugins.bundle.config', 'plugins.row.config', 'shell.overlay']));
  expect(document.body.textContent).toContain('监控在线');
  expect(document.body.textContent).toContain('已监控请求3');
  const Summary = slots.find(s => s.meta.name === 'plugins.row.config').component;
  await act(async () => { root.render(React.createElement(Summary, { view: 'summary' })); });
  expect(document.body.textContent).toContain('已监控 3 次');
  expect(document.querySelectorAll('button')).toHaveLength(0);
  await act(async () => { root.render(React.createElement(Summary, { view: 'page' })); });
  await act(async () => { button('启用监控').click(); });
  expect(document.body.textContent).toContain('监控已暂停');
  await act(async () => { button('启用监控').click(); });
  await act(async () => { button('离线自检').click(); });
  expect(document.body.textContent).toContain('未调用模型，未计入真实告警');
  expect(data.confirmed).toBe(0);
});
it('identifies conversations and turns, filters incidents and opens the native conversation without exporting titles', async () => {
  const openSession = vi.fn();
  const incident = { kind: 'stream-repeat', contentType: 'reasoning', confirmed: true, score: 98, chars: 4000,
    session: 'key-a', period: 21, repeats: 64, coverage: 0.98, novelty: 0.01, turn: 7, step: 3, time: '2026-11-11T11:01:00Z' };
  const data = { ...baseline(), confirmed: 1, events: [incident, { ...incident, session: 'key-b', turn: 2 }] };
  const items = ['a', 'b'].map(id => ({ ...sessionData(), sessionId: id, sessionKey: 'key-' + id, turn: 7, step: 3, tracked: true }));
  const { url } = await mount(async (_channel, method) => ({ ok: true, value: method === 'conversations' ? items : data }), undefined,
    { sessions: { list: { getSnapshot: () => ({ byId: { a: { title: '合成迁移任务' }, b: { title: '合成解析任务' } } }) } }, uiWorkspace: { openSession } });
  expect(document.body.textContent).toContain('合成迁移任务');
  expect(document.body.textContent).toContain('第 7 轮 · 步骤 3');
  expect(document.body.textContent).toContain('窗口覆盖 98%');
  await act(async () => { button('查看此对话记录').click(); });
  expect(document.querySelectorAll('.fs-event')).toHaveLength(1);
  expect(document.querySelector('.fs-event').textContent).toContain('合成迁移任务');
  await act(async () => { button('打开对话').click(); });
  expect(openSession).toHaveBeenCalledWith('a');
  vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => { button('导出诊断日志').click(); });
  expect(await url.createObjectURL.mock.calls[0][0].text()).not.toContain('合成迁移任务');
});
it('updates live health from flowing output to suspicion and confirmation, without promising prevention', async () => {
  const live = { risk: 'clear', active: true, reasoningChars: 5800, textChars: 0, analyzedChars: 5800, checks: 12,
    turn: 4, step: 2, silentForMs: 100, lastOutputAt: '2026-11-11T11:00:00Z', lastCheckAt: '2026-11-11T11:00:00Z' };
  const data = { ...sessionData(), coverage: 'monitoring', live, toolResults: 3 };
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? structuredClone(data) : baseline() }), 'a');
  expect(document.body.textContent).toContain('持续检测 · 暂未发现循环');
  await act(async () => { document.querySelector('.fs-dock-button').click(); });
  expect(document.body.textContent).toContain('推理 5,800 字符');
  expect(document.body.textContent).toContain('已检查 12 次');
  expect(document.body.textContent).toContain('工具结果 3 次');
  expect(document.body.textContent).toContain('不能保证后续不会重复');
  data.live.risk = 'suspected';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(document.querySelector('.fs-dock-button').textContent).toContain('疑似重复');
  data.live.risk = 'confirmed';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(document.querySelector('.fs-dock-button').textContent).toContain('确认重复 · 未中断');
});
it.each([
  [{ risk: 'collecting', active: true, reasoningChars: 15, textChars: 0, checks: 0, silentForMs: 100 }, '接收输出 · 积累检测样本'],
  [{ risk: 'collecting', active: true, reasoningChars: 0, textChars: 0, checks: 0, silentForMs: 100 }, '等待模型首个输出'],
  [{ risk: 'clear', active: true, reasoningChars: 4000, textChars: 0, checks: 3, silentForMs: 31000 }, '等待输出 · 尚不能判断'],
  [{ risk: 'collecting', active: false, reasoningChars: 15, textChars: 0, checks: 0, silentForMs: 0 }, '请求结束 · 检测样本不足'],
  [{ risk: 'incomplete', incomplete: true, active: true, reasoningChars: 0, textChars: 0, checks: 0, silentForMs: 0 }, '检测不完整 · 内容块超限'],
])('labels incomplete observations honestly: %s', async (live, label) => {
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? { ...sessionData(), coverage: live.active ? 'monitoring' : 'checked', live } : baseline() }), 'a');
  expect(document.querySelector('.fs-dock-button').textContent).toContain(label);
});
it('shows and opens real incident alerts and exports only the host diagnostic payload', async () => {
  const data = baseline();
  data.events = [{ kind: 'stream-repeat', confirmed: true, score: 98, chars: 4000, session: 'hashed', time: '2026-11-11T11:01:00Z' }]; data.confirmed = 1;
  const { selectPanel, url } = await mount(vi.fn(async () => ({ ok: true, value: data })));
  expect(document.querySelector('[role="alert"]').textContent).toContain('确认输出重复');
  expect(document.querySelector('[role="alert"]').textContent).toContain('未拦截');
  await act(async () => { button('查看记录').click(); });
  expect(selectPanel).toHaveBeenCalledWith('flash-stabilizer');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  const clicked = vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await act(async () => { button('导出诊断日志').click(); });
  expect(clicked).toHaveBeenCalledOnce(); expect(url.createObjectURL).toHaveBeenCalledOnce();
  const blob = url.createObjectURL.mock.calls[0][0];
  expect(JSON.parse(await blob.text()).events[0].session).toBe('hashed');
});
it('marks connection failure visibly and recovers on refresh', async () => {
  let fail = true;
  await mount(async () => { if (fail) throw Error('offline'); return { ok: true, value: baseline() }; });
  expect(document.body.textContent).toContain('监控服务未连接');
  expect(button('启用监控').disabled).toBe(true);
  fail = false;
  await act(async () => { button('刷新状态').click(); });
  expect(document.body.textContent).toContain('监控在线');
});
it.each(['snapshot', 'conversations'])('does not show stale live health after %s disconnects', async endpoint => {
  let fail = false;
  const item = { ...sessionData(), sessionId: 'a', sessionKey: 'key-a', tracked: true, coverage: 'monitoring',
    live: { risk: 'clear', active: true, reasoningChars: 4000, textChars: 0, analyzedChars: 4000, checks: 3, silentForMs: 100 } };
  await mount(async (_channel, method) => {
    if (fail && method === endpoint) throw Error('offline');
    return { ok: true, value: method === 'conversations' ? [item] : baseline() };
  });
  expect(document.querySelector('.fs-conversation .fs-state').textContent).toContain('暂未发现循环');
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(document.querySelector('.fs-conversation .fs-state').textContent).toContain('状态已过期');
  expect(document.querySelector('.fs-conversation .fs-state').dataset.tone).toBe('off');
  expect(document.body.textContent).toContain('以下为上次同步数据');
  fail = false;
  await act(async () => { button('刷新状态').click(); });
  expect(document.querySelector('.fs-conversation .fs-state').textContent).toContain('暂未发现循环');
  expect(document.body.textContent).not.toContain('以下为上次同步数据');
});
it('rejects a stale polling response after pause so the screen stays paused', async () => {
  let resolve;
  let poll = 0;
  await mount(async (_channel, method) => {
    if (method === 'setMonitoring') return { ok: true, value: { ...baseline(), monitoring: false } };
    if (++poll === 1) return { ok: true, value: baseline() };
    return new Promise(r => { resolve = r; });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { button('启用监控').click(); });
  await act(async () => { resolve({ ok: true, value: baseline() }); });
  expect(document.body.textContent).toContain('监控已暂停');
});
const sessionData = () => ({ monitoring: true, mode: 'observe', coverage: 'checked', monitoredRequests: 2,
  activeRequests: 0, confirmed: 0, toolWarnings: 0, recoverySubmitted: 0, cancelRequested: 0, lastMonitoredAt: null, latestEvent: null, events: [] });
it('shows a scoped status in each conversation and explains evidence without claiming interception', async () => {
  const current = sessionData();
  current.confirmed = 1;
  current.events = [{ kind: 'stream-repeat', contentType: 'reasoning', confirmed: true, score: 98, chars: 4000, period: 21, repeats: 64, turn: 3, step: 2, time: '2026-11-11T11:01:00Z' }];
  current.latestEvent = current.events[0];
  const call = vi.fn(async (_channel, method, payload) => ({ ok: true, value: method === 'session' ? (payload.sessionId === 'a' ? current : sessionData()) : baseline() }));
  const { slots } = await mount(call, 'a');
  expect(document.body.textContent).toContain('确认重复 · 未中断');
  await act(async () => { document.querySelector('.fs-dock-button').click(); });
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog.textContent).toContain('周期 21 字符、重复 64 次');
  expect(dialog.textContent).toContain('第 3 轮 · 步骤 2');
  expect(dialog.textContent).toContain('无，未中断模型或工具');
  expect(dialog.textContent).toContain('仅告警，未拦截');
  const Dock = slots.find(s => s.meta.name === 'conversation.composer.dock').component;
  await act(async () => { root.render(React.createElement(Dock, { sessionId: 'b' })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain('最近请求 · 未发现重复');
  expect(document.body.textContent).not.toContain('周期 21');
  expect(call).toHaveBeenCalledWith('/flash-stabilizer', 'session', { sessionId: 'b' }, expect.any(AbortSignal));
});
it.each([
  ['waiting', '待下次 Flash 请求'], ['monitoring', '正在监控'], ['other-model', '当前模型不在监控范围'],
  ['paused', '监控已暂停'], ['disabled', '此对话未启用'], ['auxiliary', '辅助请求未监控'],
  ['unavailable', '检测不完整 · 待下次请求'],
])('does not imply successful monitoring for %s', async (coverage, label) => {
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? { ...sessionData(), coverage, monitoredRequests: coverage === 'waiting' ? 0 : 2 } : baseline() }), 'a');
  expect(document.body.textContent).toContain(label);
});
it('shows tool observations and deferred corrections as distinct actions, with dismissable scoped details', async () => {
  const data = { ...sessionData(), mode: 'assist', events: [{ kind: 'recovery', action: 'correction-deferred', time: '2026-11-11T11:02:00Z' },
    { kind: 'tool-repeat', repeats: 4, time: '2026-11-11T11:01:00Z' }] };
  data.latestEvent = data.events[0];
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? data : baseline() }), 'a');
  expect(document.body.textContent).toContain('等待纠正');
  await act(async () => { document.querySelector('.fs-dock-button').click(); });
  expect(document.body.textContent).toContain('当前回合结束后提交纠正；本次输出未中断');
  expect(document.body.textContent).toContain('未阻止、跳过或重放任何工具');
  await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it('explains intermittent phrase evidence and distinguishes requested from confirmed stops', async () => {
  const phrase = { kind: 'stream-repeat', method: 'phrase', contentType: 'reasoning', confirmed: true, period: 0, repeats: 80, coverage: 0.8, novelty: 0.1, turn: 8, step: 2 };
  const data = { ...sessionData(), coverage: 'unavailable', mode: 'guard', cancelRequested: 1, events: [{ kind: 'recovery', action: 'cancel-requested' }, phrase] };
  data.latestEvent = data.events[0];
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? structuredClone(data) : baseline() }), 'a');
  expect(document.querySelector('.fs-dock-button').textContent).toContain('已请求中断');
  await act(async () => { document.querySelector('.fs-dock-button').click(); });
  expect(document.body.textContent).toContain('夹杂变化文字的短句反复出现');
  expect(document.body.textContent).toContain('短句单元占比 80%');
  expect(document.body.textContent).toContain('防护停止');
  expect(document.body.textContent).not.toContain('周期 0');
  data.latestEvent = { kind: 'recovery', action: 'stop-confirmed' };
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(document.querySelector('.fs-dock-button').textContent).toContain('已停止重复生成');
});
it('notifies uncertain repetition without claiming a confirmed loop or interruption', async () => {
  const event = { kind: 'stream-repeat', method: 'phrase', uncertainty: 'changing-numbered-units', action: 'notify-only', contentType: 'reasoning', confirmed: false, repeats: 90, time: '2026-11-12T12:00:00Z' };
  const data = { ...baseline(), mode: 'guard', events: [event] };
  await mount(async (_channel, method) => ({ ok: true, value: method === 'conversations' ? [] : data }));
  expect(document.querySelector('[role="alert"]').textContent).toContain('重复特征待确认');
  expect(document.querySelector('[role="alert"]').textContent).toContain('未自动停止或提交纠正');
  expect(document.querySelector('.fs-event-title').textContent).toBe('重复特征待确认');
});
it('shows the current request while keeping earlier incidents in conversation details', async () => {
  const data = { ...sessionData(), coverage: 'monitoring', confirmed: 1,
    events: [{ kind: 'stream-repeat', confirmed: true, time: '2026-11-11T11:01:00Z' }] };
  await mount(async (_channel, method) => ({ ok: true, value: method === 'session' ? data : baseline() }), 'a');
  expect(document.body.textContent).toContain('正在监控');
  await act(async () => { document.querySelector('.fs-dock-button').click(); });
  expect(document.querySelector('[role="dialog"]').textContent).toContain('确认输出重复');
});
