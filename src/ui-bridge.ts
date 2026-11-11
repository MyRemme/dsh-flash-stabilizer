import type { StabilizerAPI } from './index.js';
import type { HostContext, RpcHandler } from './types.js';

/** Uses the host's authenticated transport; never opens a separate listener. */
export function registerUI(ctx: HostContext, api: StabilizerAPI): unknown {
  // The host binds RPC route ownership to this child context. Its route
  // registration reads webServer through that owner, so declare both services.
  return ctx.inject?.(['connection', 'webServer'], child => {
    const handler: RpcHandler = (endpoint, payload, signal, peer) => {
      const fail = (code: string, message: string) => ({ ok: false, error: { code, message, details: {} } });
      if (peer?.principal?.kind !== 'owner') return fail('FORBIDDEN', 'Owner access required');
      if (signal.aborted) return fail('ABORTED', 'Request cancelled');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('BAD_REQUEST', 'Invalid payload');
      const keys = Object.keys(payload);
      if (endpoint === 'setMonitoring') {
        const enabled = (payload as { enabled?: unknown }).enabled;
        if (keys.length !== 1 || typeof enabled !== 'boolean') return fail('BAD_REQUEST', 'Expected enabled boolean');
        api.setMonitoring(enabled);
        return { ok: true, value: api.status() };
      }
      if (keys.length) return fail('BAD_REQUEST', 'Expected empty payload');
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
