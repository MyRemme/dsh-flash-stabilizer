import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeProfileFile } from './profile-file.js';
import { sessionKey } from './metrics.js';
import type { HostContext, PreToolDecision, ToolExecution } from './types.js';

/** Separately verified by scripts/safety-host-probe.mjs; not the loop-monitor matrix. */
export const SAFETY_HOSTS = ['0.2.1-rc.2', '0.2.2-rc.1'] as const;
const SHELL_TOOLS = ['pwsh', 'bash', 'ops_bash', 'exec_command'] as const;
const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'multi_edit'] as const;
const DELETE_TOOLS = ['delete', 'remove_file', 'delete_file'] as const;
export const SAFETY_TOOLS: readonly string[] = [...SHELL_TOOLS, ...WRITE_TOOLS, ...DELETE_TOOLS];
type Mode = 'read-only' | 'workspace-write' | 'danger-full-access';
interface Policy { mode: Mode; workspaceRoot: string }
type Rule = 'elevation' | 'read-only-write' | 'read-only-unknown' | 'destructive' | 'opaque-execution'
  | 'invalid-arguments' | 'policy-unavailable' | 'host-unverified' | 'guard-unavailable' | 'settings-invalid'
  | 'check-failed' | 'approval-unavailable' | 'configuration-changed' | 'cancelled';
type Assessment = { kind: 'allow' } | { kind: 'deny' | 'ask'; rule: Rule };
export interface SafetyEvent {
  time: string; session: string; tool: string; mode: Mode | 'unknown';
  action: 'denied' | 'approval-requested' | 'approved' | 'rejected' | 'cancelled'; rule: Rule;
}
export interface SafetyStatus {
  enabled: boolean; state: 'disabled' | 'active' | 'blocked' | 'disposed';
  reason: Rule | null; hostVersion: string; verifiedHosts: readonly string[]; coveredTools: readonly string[];
  persistent: boolean; checked: number; denied: number; approvalRequests: number; approved: number;
  events: SafetyEvent[];
}
interface ApprovalService {
  request(input: { agent: NonNullable<ToolExecution['agent']>; callId: string; toolName: string; reason: string; signal: AbortSignal }): Promise<unknown>;
}
const reasons: Record<Rule, string> = {
  elevation: '禁止通过工具借道系统提权。请由用户在工具之外自行处理管理员操作。',
  'read-only-write': '当前为只读模式，此调用包含修改操作。请由用户显式切换宿主权限后重试。',
  'read-only-unknown': '只读模式无法确认此命令仅进行读取，已阻止执行。请使用受控读取工具。',
  destructive: '此调用包含删除、覆盖历史或系统配置修改，需要批准本次具体操作。',
  'opaque-execution': '此调用包含脚本、动态执行或启动其他程序，需要批准本次具体操作。',
  'invalid-arguments': '无法可靠读取本次工具参数。', 'policy-unavailable': '无法读取宿主当前权限模式。',
  'host-unverified': '当前宿主版本尚未通过操作防护验证。', 'guard-unavailable': '宿主未提供可用的执行前硬拦截接口。',
  'settings-invalid': '操作防护设置无法读取，请在面板重新保存设置。', 'check-failed': '操作防护检查异常，已阻止本次调用。',
  'approval-unavailable': '缺少可用的单次审批服务或调用身份。',
  'configuration-changed': '等待审批期间权限或防护设置发生变化，请重新提交调用。', cancelled: '操作已取消。',
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Conservative recognition, not a shell parser or an OS sandbox. Inspect nested literal payloads too. */
export function assessCommand(command: string, mode: Mode): Assessment {
  if (!command.trim() || command.length > 65536) return { kind: 'deny', rule: 'invalid-arguments' };
  const text = command.replace(/`\r?\n/g, '').replace(/[`^]/g, '').toLowerCase();
  if (/\brunas(?:\.exe)?\b|\bshellexecute\b|elevation:administrator/.test(text)
    || /\b(?:start-process|saps)\b[\s\S]*?-(?:verb|v)\s+['"]?runas\b/.test(text)
    || /\bschtasks(?:\.exe)?\b[\s\S]*?\/(?:create|change)\b/.test(text)
    || /\bsc(?:\.exe)?\s+(?:create|config)\b/.test(text)) return { kind: 'deny', rule: 'elevation' };
  const commandWord = (words: string) => new RegExp(`(?:^|[\\s;&|({"'])${words}(?=$|[\\s;|&)}"'])`, 'i').test(text);
  const destructive = commandWord('(?:remove-item|ri|rm|del|erase|rmdir|rd|unlink|clear-content|format(?:\\.com)?|diskpart|bcdedit|takeown|icacls)')
    || /\breg(?:\.exe)?\s+(?:add|delete|import|restore)\b|\bgit\s+(?:reset\b[^\r\n]*--hard|clean\b|push\b[^\r\n]*--force)/.test(text);
  const modifies = destructive || commandWord('(?:set-content|add-content|out-file|new-item|ni|copy-item|cp|copy|move-item|mv|move|rename-item|ren|mkdir|md|touch|tee|set-item|set-itemproperty|remove-itemproperty|new-itemproperty|clear-itemproperty|set-acl|set-service|stop-service|restart-service|set-ciminstance|invoke-cimmethod)')
    || /(?:^|[^<])>{1,2}|\bgit\s+(?:add|commit|checkout|switch|restore|merge|rebase|cherry-pick|revert|stash|pull|fetch|config)\b/.test(text);
  if (mode === 'read-only') {
    if (modifies) return { kind: 'deny', rule: 'read-only-write' };
    // Only a small literal cmdlet subset is admitted. Pipelines, native shells,
    // expressions, script blocks and indirection remain outside this subset.
    const read = /^(?:get-content|get-item|get-childitem|get-location|get-filehash|test-path|select-string|pwd)(?:\s|$)/i.test(command.trim());
    return read && !/[`$;&|<>{}\r\n]/.test(command) ? { kind: 'allow' } : { kind: 'deny', rule: 'read-only-unknown' };
  }
  if (destructive) return { kind: 'ask', rule: 'destructive' };
  if (commandWord('(?:invoke-expression|iex|start-process|saps|cmd(?:\\.exe)?|powershell(?:\\.exe)?|pwsh(?:\\.exe)?|bash|sh|wscript(?:\\.exe)?|cscript(?:\\.exe)?|mshta(?:\\.exe)?|python(?:3|\\.exe)?|node(?:\\.exe)?)')
    || /-(?:encodedcommand|enc|ec|e)\b|frombase64string|shell\.application|(?:^|[\s;])(?:&|\.)\s|\$\(|\.(?:ps1|bat|cmd|vbs|js|py)(?:\s|['"]|$)/.test(text)) return { kind: 'ask', rule: 'opaque-execution' };
  // Native executables and shell constructs outside the small understood set
  // require review, including absolute executable paths and custom scripts.
  const ordinary = /^(?:get-content|get-item|get-childitem|get-location|get-filehash|get-process|test-path|select-string|select-object|measure-object|compare-object|write-output|write-host|echo|pwd|set-content|add-content|out-file|new-item|copy-item|move-item|rename-item)(?:\s|$)/i.test(command.trim());
  return ordinary && !/[;&|`(){}\r\n]/.test(command) && !/\.(?:ps1|bat|cmd|exe)\b/i.test(command)
    ? { kind: 'allow' } : { kind: 'ask', rule: 'opaque-execution' };
}

export class OperationSafety {
  private enabled: boolean;
  private settingsError = false;
  private disposed = false;
  private registered = false;
  private revision = 0;
  private readonly shutdown = new AbortController();
  private readonly grants = new WeakMap<ToolExecution, { key: string; revision: number }>();
  private readonly decisions = new WeakSet<ToolExecution>();
  private readonly events: SafetyEvent[] = [];
  private readonly file: string | undefined;
  private saving: Promise<unknown> = Promise.resolve();
  private checked = 0; private denied = 0; private approvalRequests = 0; private approved = 0;
  private unregister: (() => void) | undefined;
  constructor(private readonly ctx: HostContext, enabled: boolean, private readonly hostVersion: string, profileDir?: string) {
    this.enabled = enabled;
    this.file = profileDir ? join(profileDir, '.flash-stabilizer', 'operation-safety.json') : undefined;
    if (this.file) {
      try {
        if (statSync(this.file).size > 4096) throw new Error('oversized settings');
        const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
        if (!isRecord(saved) || Object.keys(saved).length !== 1 || typeof saved.enabled !== 'boolean') throw new Error('invalid settings');
        this.enabled = saved.enabled;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.settingsError = true; this.enabled = true; }
      }
    }
    try {
      const tools = (ctx.get?.('tools', false) ?? ctx.tools) as HostContext['tools'];
      if (typeof tools?.guard === 'function') {
        this.unregister = tools.guard(exec => this.guard(exec));
        this.registered = typeof this.unregister === 'function';
      }
    } catch { /* The pre-execute gate still denies covered calls when enabled. */ }
    ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => this.before(exec, next));
    ctx.effect(() => () => this.close(), 'flash-stabilizer: operation safety');
  }
  private service(name: string): unknown { return this.ctx.get?.(name, false); }
  private capabilityReason(): Rule | null {
    if (this.settingsError) return 'settings-invalid';
    if (!SAFETY_HOSTS.some(version => version === this.hostVersion)) return 'host-unverified';
    if (!this.registered) return 'guard-unavailable';
    try {
      if (typeof (this.service('sandboxPolicy') as { resolve?: unknown } | undefined)?.resolve !== 'function') return 'policy-unavailable';
    } catch { return 'policy-unavailable'; }
    return null;
  }
  private policy(exec: ToolExecution): Policy {
    const service = this.service('sandboxPolicy') as { resolve(input: { session?: NonNullable<ToolExecution['agent']>['session'] }): unknown } | undefined;
    const policy = service?.resolve(exec.agent?.session ? { session: exec.agent.session } : {});
    if (!isRecord(policy) || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode as string)
      || typeof policy.workspaceRoot !== 'string' || !policy.workspaceRoot.trim()) throw new Error('policy-unavailable');
    return policy as unknown as Policy;
  }
  private assessment(exec: ToolExecution, policy: Policy): Assessment {
    if (!isRecord(exec.arguments)) return { kind: 'deny', rule: 'invalid-arguments' };
    if ((SHELL_TOOLS as readonly string[]).includes(exec.name)) {
      const supplied = ['command', 'cmd', 'script', 'code'].filter(key => exec.arguments && Object.hasOwn(exec.arguments, key));
      if (supplied.length !== 1 || typeof exec.arguments[supplied[0]!] !== 'string') return { kind: 'deny', rule: 'invalid-arguments' };
      return assessCommand(exec.arguments[supplied[0]!] as string, policy.mode);
    }
    if (policy.mode === 'read-only') return { kind: 'deny', rule: 'read-only-write' };
    if ((DELETE_TOOLS as readonly string[]).includes(exec.name)) return { kind: 'ask', rule: 'destructive' };
    if (exec.name === 'apply_patch' && Object.values(exec.arguments).some(value => typeof value === 'string' && /^\*\*\* (?:Delete File|Move to):/m.test(value))) return { kind: 'ask', rule: 'destructive' };
    return { kind: 'allow' };
  }
  private inspect(exec: ToolExecution): { assessment: Assessment; policy?: Policy } {
    const unavailable = this.capabilityReason();
    if (unavailable) return { assessment: { kind: 'deny', rule: unavailable } };
    let policy: Policy;
    try { policy = this.policy(exec); } catch { return { assessment: { kind: 'deny', rule: 'policy-unavailable' } }; }
    return { assessment: this.assessment(exec, policy), policy };
  }
  private key(exec: ToolExecution, policy: Policy): string {
    return createHash('sha256').update(JSON.stringify([exec.name, exec.callId, exec.arguments, policy])).digest('hex');
  }
  private record(exec: ToolExecution, action: SafetyEvent['action'], rule: Rule, policy?: Policy): void {
    this.events.unshift({ time: new Date().toISOString(), session: sessionKey(exec.agent?.id ?? ''), tool: exec.name,
      mode: policy?.mode ?? 'unknown', action, rule });
    this.events.length = Math.min(this.events.length, 100);
    if (action === 'denied' || action === 'rejected' || action === 'cancelled') this.denied++;
    if (action === 'approval-requested') this.approvalRequests++;
    if (action === 'approved') this.approved++;
  }
  private deny(exec: ToolExecution, rule: Rule, policy?: Policy): { kind: 'deny'; reason: string } {
    if (!this.decisions.has(exec)) { this.record(exec, 'denied', rule, policy); this.decisions.add(exec); }
    return { kind: 'deny', reason: `Flash 操作防护：${reasons[rule]}` };
  }
  private covered(exec: ToolExecution): boolean { return SAFETY_TOOLS.includes(exec.name); }
  private guard(exec: ToolExecution): string | undefined {
    if (!this.enabled || !this.covered(exec)) return;
    try {
      if (this.disposed || exec.signal?.aborted) return this.deny(exec, 'cancelled').reason;
      const { assessment, policy } = this.inspect(exec);
      if (assessment.kind === 'deny') return this.deny(exec, assessment.rule, policy).reason;
      if (assessment.kind === 'ask') {
        const grant = this.grants.get(exec);
        if (!policy || grant?.revision !== this.revision || grant.key !== this.key(exec, policy)) return this.deny(exec, 'approval-unavailable', policy).reason;
        this.grants.delete(exec); // one invocation, never a command-prefix permission
      }
    } catch { return this.deny(exec, 'check-failed').reason; }
  }
  private async before(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (!this.enabled || !this.covered(exec)) return next();
    this.checked++;
    try {
      if (this.disposed || exec.signal?.aborted) return this.deny(exec, 'cancelled');
      const { assessment, policy } = this.inspect(exec);
      if (assessment.kind === 'deny') return this.deny(exec, assessment.rule, policy);
      if (assessment.kind === 'allow') return next();
      const approval = this.service('approval') as ApprovalService | undefined;
      if (!approval?.request || !exec.agent || !exec.callId || !exec.signal || !policy) return this.deny(exec, 'approval-unavailable', policy);
      const revision = this.revision, key = this.key(exec, policy);
      const signal = AbortSignal.any([exec.signal, this.shutdown.signal]);
      // Full, frozen input is shown only in the host's approval UI/log, not in
      // plugin diagnostics. No model-provided description substitutes for it.
      const details = JSON.stringify({ tool: exec.name, workspace: policy.workspaceRoot,
        workdir: isRecord(exec.arguments) ? exec.arguments.workdir ?? exec.arguments.cwd ?? policy.workspaceRoot : policy.workspaceRoot,
        arguments: exec.arguments }, null, 2);
      if (details.length > 65536) return this.deny(exec, 'invalid-arguments', policy);
      this.record(exec, 'approval-requested', assessment.rule, policy);
      const outcome = await approval.request({ agent: exec.agent, callId: exec.callId, toolName: exec.name,
        reason: `Flash 操作防护：${reasons[assessment.rule]}\n以下为本次调用的完整参数（仅允许一次）：\n${details}`, signal });
      if (signal.aborted || this.disposed) return this.deny(exec, 'cancelled', policy);
      if (revision !== this.revision || key !== this.key(exec, this.policy(exec))) return this.deny(exec, 'configuration-changed', policy);
      if (outcome !== 'allowed-once') {
        this.record(exec, outcome === 'cancelled' ? 'cancelled' : 'rejected', assessment.rule, policy); this.decisions.add(exec);
        return { kind: 'deny', reason: 'Flash 操作防护：本次调用未获得批准，禁止改写后绕过执行。' };
      }
      this.grants.set(exec, { key, revision }); this.record(exec, 'approved', assessment.rule, policy);
    } catch { return this.deny(exec, 'check-failed'); }
    return next(); // downstream policy remains authoritative
  }
  status(): SafetyStatus {
    const reason = this.capabilityReason();
    return { enabled: this.enabled, state: this.disposed ? 'disposed' : !this.enabled ? 'disabled' : reason ? 'blocked' : 'active',
      reason, hostVersion: this.hostVersion || 'unknown', verifiedHosts: [...SAFETY_HOSTS], coveredTools: [...SAFETY_TOOLS], persistent: !!this.file,
      checked: this.checked, denied: this.denied, approvalRequests: this.approvalRequests, approved: this.approved,
      events: this.events.map(event => ({ ...event })) };
  }
  setEnabled(enabled: boolean): Promise<SafetyStatus> {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('expected enabled boolean'));
    const operation = this.saving.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error('operation safety disposed');
      if (this.file) await writeProfileFile(this.file, JSON.stringify({ enabled }, null, 2) + '\n');
      this.enabled = enabled; this.settingsError = false; this.revision++;
      return this.status();
    });
    this.saving = operation; return operation;
  }
  async close(): Promise<void> {
    this.disposed = true; this.shutdown.abort(); this.unregister?.(); await this.saving.catch(() => {});
  }
}
