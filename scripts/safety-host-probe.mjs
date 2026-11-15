import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only fake tool bodies are registered. No shell is launched and no target is deleted.
const runtimeRoot = resolve(process.argv[2] ?? '.'), version = process.argv[3] ?? '0.2.2-rc.1';
const require = createRequire(resolve(runtimeRoot, 'package.json'));
const load = name => {
  const file = require.resolve(name);
  assert.ok(!relative(runtimeRoot, file).startsWith('..'), `isolated host: ${name}`);
  return import(pathToFileURL(file).href);
};
const optional = async name => { try { return await load(name); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return undefined; throw error; } };
const [{ Context }, llm, sessions, projections, prompt, tools, agents, loop, approval, stabilizer] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-session'),
  optional('@deepseek-ai/dsh-session-projection'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-agent'), load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-user-approval'),
  process.argv[4] ? import(pathToFileURL(resolve(process.argv[4])).href) : import('../dist/index.js'),
]);
const ctx = new Context(), checks = [];
let current;
try {
  for (const service of [llm.default, sessions.default, projections?.default, prompt.default, tools.default, agents.default, loop.default, approval.default].filter(Boolean)) {
    await ctx.plugin(service, service === prompt.default ? { personaPrefix: '', personaSuffix: '' } : service === loop.default ? { agents: [] } : {});
  }
  if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
  let mode = 'workspace-write', outcome = 'rejected', pendingCall, issued = false, bodies = 0;
  const requests = [];
  // The real policy-service contract is supplied without an OS executor. This
  // verifies policy consumption, approval/audit and dispatch, not Windows isolation.
  await ctx.plugin(owner => {
    owner.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({ mode, workspaceRoot: session?.header.cwd || 'D:\\fixture' }) });
    owner.provide('profileContext', { installAnchor: resolve(runtimeRoot, 'package.json') });
  });
  ctx.on('approval/request', async request => { requests.push(request); return outcome; });
  class Adapter extends llm.LlmAdapter {
    async *stream() {
      if (!issued) {
        issued = true;
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `fixture-${requests.length}-${bodies}`, name: pendingCall.name, arguments: JSON.stringify(pendingCall.arguments) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture complete.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
  let bypassPre = false;
  ctx.on('tools/pre-execute', async (_exec, next) => bypassPre ? { kind: 'allow' } : next());
  for (const name of ['pwsh', 'write']) ctx.tools.register({
    name, description: 'Inert security fixture; does not perform the requested operation.',
    parameters: name === 'pwsh' ? { command: { type: 'string', required: true } } : { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'inert fixture body'; },
  });
  ctx.tools.register({ name: 'relay_fixture', description: 'Dispatch a protected nested tool through the real registry.',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args, exec) => {
      if (typeof ctx.tools.setExecutor === 'function') {
        const result = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: 'nested-fixture', name: 'pwsh', arguments: JSON.stringify(args) }], agent: exec.agent, signal: exec.signal });
        assert.equal(result.results[0].result.isError, true);
      } else {
        const result = await ctx.tools.execute({ callId: 'nested-fixture', rootCallId: exec.rootCallId, parent: exec.token,
          name: 'pwsh', arguments: args, agent: exec.agent, signal: exec.signal });
        assert.equal(result.isError, true);
      }
      return 'nested denial verified';
    },
  });
  await ctx.plugin(stabilizer, { operationSafety: true, modelScope: 'selected', modelSelections: [] });
  const api = ctx.get('flashStabilizer');
  assert.equal(api.operationSafety().hostVersion, version); assert.equal(api.operationSafety().state, 'active');
  checks.push('detected-host-and-active-guard');
  current = await ctx.agentLoop.create(sessions.SessionId(`operation-safety-${version}`), { provider: 'fixture', model: 'unselected-model' });
  api.setMonitoring(false); api.setSessionEnabled(current.id, false);
  const run = async (name, args) => {
    pendingCall = { name, arguments: args }; issued = false;
    current.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Run inert fixture.' }], source: { kind: 'user' } }));
    let timer;
    try { await Promise.race([current.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('safety probe timeout')), 10000); })]); }
    finally { clearTimeout(timer); }
  };
  await run('pwsh', { command: 'Start-Process cmd.exe -Verb RunAs' });
  assert.equal(bodies, 0); assert.equal(requests.length, 0); checks.push('elevation-blocked-before-body');
  mode = 'read-only';
  await run('write', { path: 'D:\\fixture\\never-created.txt', content: 'never written' });
  await run('pwsh', { command: 'cmd /c del /f /a D:\\fixture\\never-deleted.txt' });
  assert.equal(bodies, 0); checks.push('readonly-write-and-shell-denied');
  await run('pwsh', { command: 'Get-Location' }); assert.equal(bodies, 1); checks.push('readonly-simple-read');
  mode = 'workspace-write';
  await run('pwsh', { command: 'Remove-Item D:\\fixture\\never-deleted.txt' });
  assert.equal(bodies, 1); assert.equal(requests.length, 1); checks.push('approval-rejection-no-body');
  outcome = 'allowed-once';
  await run('pwsh', { command: 'Remove-Item D:\\fixture\\never-deleted.txt' });
  assert.equal(bodies, 2); assert.equal(requests.length, 2); checks.push('approval-grants-one-inert-body');
  outcome = 'rejected';
  await run('pwsh', { command: 'Remove-Item D:\\fixture\\never-deleted.txt' });
  assert.equal(bodies, 2); assert.equal(requests.length, 3); checks.push('next-invocation-requires-new-approval');
  assert.ok(requests.every(request => request.callId && request.reason.includes('never-deleted.txt')));
  const events = current.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'approval/asked').length, 3);
  assert.equal(events.filter(event => event.type === 'approval/decided').length, 3); checks.push('real-approval-audit-pairs');
  bypassPre = true;
  await run('pwsh', { command: 'Start-Process cmd.exe -Verb RunAs' });
  await run('pwsh', { command: 'Remove-Item D:\\fixture\\never-deleted.txt' });
  assert.equal(bodies, 2); assert.equal(requests.length, 3); bypassPre = false; checks.push('hard-denial-survives-pre-hook-allow');
  await run('relay_fixture', { command: 'Start-Process cmd.exe -Verb RunAs' });
  assert.equal(bodies, 2); assert.ok(api.operationSafety().events.some(event => event.rule === 'elevation')); checks.push('nested-tool-dispatch-guarded');
  const exported = JSON.stringify(api.status());
  assert.ok(!exported.includes('never-deleted.txt') && !exported.includes(current.id)); checks.push('redacted-diagnostics');
  checks.push('independent-monitor-pause-session-pause-model-scope');
  await api.setOperationSafety(false);
  await run('pwsh', { command: 'Remove-Item D:\\fixture\\never-deleted.txt' }); assert.equal(bodies, 3);
  checks.push('owner-disable-restores-host-behavior');
  console.log('SAFETY_PROBE_RESULT ' + JSON.stringify({ version, status: 'passed', checks, toolBodies: bodies, shellProcesses: 0, realDeletes: 0 }));
} finally { await ctx.fiber.dispose(); }
