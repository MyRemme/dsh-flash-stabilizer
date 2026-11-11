import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
it('loads and unloads in the real published DSH AgentLoop and detects actual tool results', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/host-probe.mjs', '.', '0.2.2-rc.1'], { cwd: process.cwd(), timeout: 30000, windowsHide: true });
  const result = JSON.parse(/PROBE_RESULT (.+)/.exec(stdout)![1]!);
  expect(result.status).toBe('passed');
  expect(result.checks).toContain('lossless-chunks');
  expect(result.checks).toContain('tool-results');
  expect(result.checks).toContain('unload');
}, 35000);
