import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';

for (const [root, version] of [['.', '0.2.2-rc.1'], ['.compat-cache/runtimes/0.2.1-rc.2', '0.2.1-rc.2']]) {
  it.skipIf(!existsSync(`${root}/node_modules/@deepseek-ai/dsh-agent-loop/package.json`))(`blocks tool dispatch and audits single approvals in real DSH ${version}`, async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/safety-host-probe.mjs', root!, version!], { timeout: 30000, windowsHide: true });
    const result = JSON.parse(/SAFETY_PROBE_RESULT (.+)/.exec(stdout)![1]!);
    expect(result).toMatchObject({ version, status: 'passed', shellProcesses: 0, realDeletes: 0 });
    for (const check of ['elevation-blocked-before-body', 'readonly-write-and-shell-denied', 'approval-rejection-no-body',
      'approval-grants-one-inert-body', 'next-invocation-requires-new-approval', 'real-approval-audit-pairs',
      'hard-denial-survives-pre-hook-allow', 'nested-tool-dispatch-guarded', 'independent-monitor-pause-session-pause-model-scope', 'redacted-diagnostics']) expect(result.checks).toContain(check);
  }, 35000);
}
