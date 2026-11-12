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
  expect(result.checks).toContain('max-tokens-new-turn');
  expect(result.checks).toContain('recovery-tool-result');
  expect(result.checks).toContain('assist-user-stop');
  expect(result.checks).toContain('guard-cancel');
  expect(result.checks).toContain('guard-no-retry');
}, 35000);
