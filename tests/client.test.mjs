import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
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
async function mount(call) {
  let plugin;
  const slots = [];
  const url = { createObjectURL: vi.fn(() => 'blob:diagnostic'), revokeObjectURL: vi.fn() };
  runInNewContext(readFileSync(new URL('../client/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { plugin = value.factory(() => React); } } },
    document, URL: url, Blob, AbortController, setInterval, clearInterval, setTimeout, clearTimeout,
  });
  const selectPanel = vi.fn();
  await act(async () => {
    plugin.apply({ connection: { rpc: { call } }, layout: { selectPanel }, effect: fn => cleanup.push(fn()),
      slots: { inject: (_name, fn) => fn(), register: (meta, component) => slots.push({ meta, component }) } });
    const Panel = slots.find(s => s.meta.name === 'main').component;
    const Toast = slots.find(s => s.meta.name === 'shell.overlay').component;
    root.render(React.createElement(React.Fragment, null, React.createElement(Panel), React.createElement(Toast)));
  });
  return { slots, url, selectPanel };
}
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
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
  await act(async () => { button('暂停监控').click(); });
  expect(document.body.textContent).toContain('监控已暂停');
  await act(async () => { button('继续监控').click(); button('离线自检').click(); });
  await act(async () => { button('离线自检').click(); });
  expect(document.body.textContent).toContain('未调用模型，未计入真实告警');
  expect(data.confirmed).toBe(0);
});
it('shows and opens real incident alerts and exports only the host diagnostic payload', async () => {
  const data = baseline();
  data.events = [{ kind: 'stream-repeat', confirmed: true, score: 98, chars: 4000, session: 'hashed', time: '2026-11-11T11:01:00Z' }]; data.confirmed = 1;
  const { selectPanel, url } = await mount(vi.fn(async () => ({ ok: true, value: data })));
  expect(document.querySelector('[role="alert"]').textContent).toContain('已确认');
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
  expect(button('继续监控').disabled).toBe(true);
  fail = false;
  await act(async () => { button('刷新状态').click(); });
  expect(document.body.textContent).toContain('监控在线');
});
it('rejects a stale polling response after pause so the screen stays paused', async () => {
  let resolve;
  let poll = 0;
  await mount(async (_channel, method) => {
    if (method === 'setMonitoring') return { ok: true, value: { ...baseline(), monitoring: false } };
    if (++poll === 1) return { ok: true, value: baseline() };
    return new Promise(r => { resolve = r; });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  await act(async () => { button('暂停监控').click(); });
  await act(async () => { resolve({ ok: true, value: baseline() }); });
  expect(document.body.textContent).toContain('监控已暂停');
});
