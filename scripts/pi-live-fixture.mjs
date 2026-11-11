// Only these in-memory fixture files are accessible to the model. No shell tools.
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('./pi-live-code-check.mjs', import.meta.url));
export default function(pi) {
  const parser = process.env.PI_LIVE_FIXTURE === 'parser';
  const file = parser ? 'parser.js' : 'view.js';
  const files = {
    'store.js': '// Migration 17 already completed. Do not change or repeat it.\nconst rows = [{id: "a", label: "Alpha"}, {id: "b", label: "Beta"}];',
    'view.js': 'function renderAudit(rows, selectedId) { return { options: [], selectedId: null, readOnly: false }; }',
    'parser.js': 'function splitThinking(s) { const i=s.indexOf("</think>"); return i<0?{thinking:s,answer:""}:{thinking:s.slice(0,i),answer:s.slice(i+8)}; }',
  };
  const log = row => appendFileSync(process.env.PI_LIVE_TOOL_LOG, JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n');
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: {} });
  const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  pi.registerTool({ name: 'bench_read', label: 'Read fixture', description: 'Read one virtual test fixture: store.js, view.js, parser.js. No real workspace access.',
    parameters: schema({ path: { type: 'string' } }), async execute(_id, { path }) { log({ tool: 'read', path }); return result({ path, content: files[path] ?? null }); } });
  pi.registerTool({ name: 'bench_patch', label: 'Update fixture', description: `Replace the entire virtual ${file} source. Only this fixture can be changed.`,
    parameters: schema({ path: { type: 'string' }, content: { type: 'string' } }), async execute(_id, { path, content }) {
      const allowed = path === file && content.length < 20000; if (allowed) files[path] = content;
      log({ tool: 'patch', path, allowed, chars: content.length }); return result({ updated: allowed });
    } });
  pi.registerTool({ name: 'bench_test', label: 'Test fixture', description: `Run deterministic correctness checks for the current virtual ${file}. No project scripts or shell commands run.`,
    parameters: schema({}), async execute() {
      const path = join(process.env.PI_LIVE_FIXTURE_DIR, 'fixture-candidate.txt'); writeFileSync(path, files[file]);
      let check; try {
        const { stdout } = await promisify(execFile)(process.execPath, ['--max-old-space-size=64', worker, parser ? 'parser' : 'audit', path], { cwd: process.env.PI_LIVE_FIXTURE_DIR, env: {}, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
        check = JSON.parse(stdout);
      } catch { check = { passed: false, reason: 'Fixture check failed or timed out' }; }
      log({ tool: 'test', ...check }); return result(check);
    } });
}
