import { createHash } from 'node:crypto';
import type { ToolExecution, ToolResult } from './types.js';

class FingerprintLimitError extends RangeError {}
/** Exact JSON canonicalization; never lowercases paths, commands, or values. */
export function fingerprint(value: unknown): string {
  let nodes = 0;
  function stable(input: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 32) throw new FingerprintLimitError('fingerprint input too large');
    if (Array.isArray(input)) return input.map(v => stable(v, depth + 1));
    if (input && typeof input === 'object') {
      const entries = Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return Object.fromEntries(entries.map(([k, v]) => [k, stable(v, depth + 1)]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(stable(value, 0)) ?? 'undefined').digest('hex');
}
export interface ProgressEvidence { repeated: boolean; count: number; failed: boolean; fingerprint: string; codeEvidence: 'none' | 'changed-output' | 'unchanged-output' }
export class ProgressGuard {
  private recent = new Map<string, { result: string; count: number; time: number }>();
  constructor(private readonly limit: number, private readonly now = Date.now) {}
  record(exec: ToolExecution, result: ToolResult): ProgressEvidence {
    let call: string | undefined, output: string;
    try {
      call = fingerprint([exec.name, exec.arguments]);
      output = fingerprint([result.isError, result.content, result.value, result.error]);
    } catch (error) {
      if (!(error instanceof FingerprintLimitError)) throw error;
      // Unknown output is a gap in evidence, not another copy of the previous
      // result. Never join a repetition streak across an unexamined tool call.
      if (call) this.recent.delete(call); else this.recent.clear();
      return { repeated: false, count: 1, failed: result.isError, fingerprint: call ?? '', codeEvidence: 'none' };
    }
    const previous = this.recent.get(call);
    const same = previous?.result === output && this.now() - previous.time < 300_000;
    const count = same ? previous.count + 1 : 1;
    this.recent.delete(call);
    this.recent.set(call, { result: output, count, time: this.now() });
    if (this.recent.size > 64) this.recent.delete(this.recent.keys().next().value!);
    return { repeated: count >= this.limit, count, failed: result.isError, fingerprint: call, codeEvidence: !previous ? 'none' : same ? 'unchanged-output' : 'changed-output' };
  }
  clear(): void { this.recent.clear(); }
}
