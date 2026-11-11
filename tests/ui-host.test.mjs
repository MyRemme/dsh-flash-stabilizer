import { Context, Service } from '@deepseek-ai/cordis';
import { expect, it } from 'vitest';
import { registerUI } from '../dist/ui-bridge.js';

it('registers the authenticated route in an injected Cordis owner and removes it on unload', async () => {
  const ctx = new Context(), routes = new Map();
  // Host Connection resolves the route carrier through the caller's context,
  // including Cordis's actual dependency access checks and effect lifecycle.
  class Connection extends Service {
    constructor(ctx) { super(ctx, 'connection'); }
    get rpc() {
      const owner = this.ctx;
      return { handle: (channel, handler) => this.register(owner, channel, handler) };
    }
    register(owner, channel, handler) { return owner.effect(() => owner.webServer.register({ path: channel, handler })); }
  }
  try {
    await ctx.plugin(ctx => ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => routes.delete(route.path); } }));
    await ctx.plugin(Connection);
    const api = { status: () => ({ monitoring: true }) };
    const plugin = await registerUI(ctx, api);
    expect(routes.has('/flash-stabilizer')).toBe(true);
    const result = await routes.get('/flash-stabilizer').handler('snapshot', {}, new AbortController().signal, { principal: { kind: 'owner' } });
    expect(result).toEqual({ ok: true, value: { monitoring: true } });
    await plugin.dispose();
    expect(routes.has('/flash-stabilizer')).toBe(false);
  } finally { await ctx.fiber.dispose(); }
});
