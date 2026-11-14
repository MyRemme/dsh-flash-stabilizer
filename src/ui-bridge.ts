import type { StabilizerAPI } from './index.js';
import type { HostContext, RpcHandler } from './types.js';
import type { UpdateAPI } from './updater.js';
import { validateModelScope } from './model-scope.js';

/** Uses the host's authenticated transport; never opens a separate listener. */
export function registerUI(ctx: HostContext, api: StabilizerAPI, updates: UpdateAPI): unknown {
  // The host binds RPC route ownership to this child context. Its route
  // registration reads webServer through that owner, so declare both services.
  return ctx.inject?.(['connection', 'webServer'], child => {
    const handler: RpcHandler = (endpoint, payload, signal, peer) => {
      const fail = (code: string, message: string) => ({ ok: false, error: { code, message, details: {} } });
      if (peer?.principal?.kind !== 'owner') return fail('FORBIDDEN', 'Owner access required');
      if (signal.aborted) return fail('ABORTED', 'Request cancelled');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('BAD_REQUEST', 'Invalid payload');
      const keys = Object.keys(payload);
      if (endpoint === 'setModelScope') {
        let value;
        try { value = validateModelScope(payload); } catch { return fail('BAD_REQUEST', 'Invalid model scope'); }
        return api.setModelScope(value).then(value => ({ ok: true, value }), () => fail('SETTINGS_FAILED', 'Could not save model scope'));
      }
      if (endpoint === 'setAutomaticUpdates') {
        const enabled = (payload as { enabled?: unknown }).enabled;
        if (keys.length !== 1 || typeof enabled !== 'boolean') return fail('BAD_REQUEST', 'Expected enabled boolean');
        return updates.setAutomatic(enabled).then(value => ({ ok: true, value }));
      }
      if (endpoint === 'session') {
        const sessionId = (payload as { sessionId?: unknown }).sessionId;
        if (keys.length !== 1 || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024) return fail('BAD_REQUEST', 'Expected sessionId string');
        return { ok: true, value: api.sessionStatus(sessionId) };
      }
      if (endpoint === 'setMonitoring') {
        const enabled = (payload as { enabled?: unknown }).enabled;
        if (keys.length !== 1 || typeof enabled !== 'boolean') return fail('BAD_REQUEST', 'Expected enabled boolean');
        api.setMonitoring(enabled);
        return { ok: true, value: api.status() };
      }
      if (keys.length) return fail('BAD_REQUEST', 'Expected empty payload');
      if (endpoint === 'modelScope') return { ok: true, value: api.modelScope() };
      if (endpoint === 'refreshModels') return api.refreshModels().then(value => ({ ok: true, value }), () => fail('CATALOG_FAILED', 'Could not read models'));
      if (endpoint === 'updates') return { ok: true, value: updates.status() };
      if (endpoint === 'checkUpdates') { void updates.check(); return { ok: true, value: updates.status() }; }
      if (endpoint === 'installUpdate') return { ok: true, value: updates.install() };
      if (endpoint === 'conversations') return { ok: true, value: api.conversations() };
      if (endpoint === 'snapshot') return { ok: true, value: api.status() };
      if (endpoint === 'export') return { ok: true, value: { schemaVersion: 1, exportedAt: new Date().toISOString(), ...api.status() } };
      if (endpoint === 'selfTest') return { ok: true, value: api.selfTest() };
      return fail('NOT_FOUND', 'Unknown operation');
    };
    // Some Cordis generations bind the rpc getter's captured owner to the
    // Connection service itself. The explicit-owner entry reaches the same
    // authenticated router while retaining this plugin's effect lifecycle.
    const connection = child.connection;
    if (connection?.register) connection.register(child, '/flash-stabilizer', handler);
    else connection?.rpc?.handle('/flash-stabilizer', handler);
  });
}
