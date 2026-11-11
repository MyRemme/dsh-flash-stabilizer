import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Notice } from './types.js';

export interface DiagnosticEvent extends Notice { time: string }

export class MetricsStore {
  readonly counts: Record<string, number> = Object.create(null);
  private pending: DiagnosticEvent[] = [];
  private recent: DiagnosticEvent[] = [];
  private confirmed = 0;
  private recoverySubmitted = 0;
  private draining: Promise<void> | undefined;
  private closed = false;
  private failed = false;
  constructor(private readonly directory: string, private readonly maxBytes: number, private readonly warn: () => void) {}
  record(event: Notice): void {
    if (this.closed) return;
    this.counts[event.kind] = (this.counts[event.kind] ?? 0) + 1;
    if (event.kind === 'stream-repeat' && event.confirmed) this.confirmed++;
    if (event.kind === 'recovery' && event.action === 'recovery-submitted') this.recoverySubmitted++;
    // Keep the same redacted, bounded records for the UI and disk. Never copy
    // arbitrary properties from a caller into diagnostics.
    const safe: DiagnosticEvent = {
      time: new Date().toISOString(), kind: event.kind,
      session: event.session ? createHash('sha256').update(event.session).digest('hex').slice(0, 16) : '',
      score: event.score, confirmed: event.confirmed, chars: event.chars,
      ...(event.period === undefined ? {} : { period: event.period }),
      ...(event.repeats === undefined ? {} : { repeats: event.repeats }),
      ...(event.action === undefined ? {} : { action: event.action }),
    };
    this.recent.push(safe);
    if (this.recent.length > 100) this.recent.shift();
    if (!this.directory || this.failed) return;
    if (this.pending.length >= 128) { this.counts.dropped = (this.counts.dropped ?? 0) + 1; return; }
    // No raw content, argument, command, error text, or session id reaches disk.
    this.pending.push(safe);
    this.draining ??= this.drain();
  }
  private async drain(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, 'events.jsonl');
      let size = await stat(file).then(s => s.size, () => 0);
      while (this.pending.length) {
        const lines: string[] = [];
        let bytes = 0;
        while (this.pending.length && lines.length < 32) {
          const line = JSON.stringify(this.pending[0]) + '\n';
          const length = Buffer.byteLength(line);
          if (length > this.maxBytes) { this.pending.shift(); this.counts.dropped = (this.counts.dropped ?? 0) + 1; continue; }
          if (bytes + length > this.maxBytes) break;
          this.pending.shift(); lines.push(line); bytes += length;
        }
        if (!lines.length) continue;
        if (size + bytes > this.maxBytes) {
          await rename(file, join(this.directory, 'events.previous.jsonl')).catch(error => { if (error.code !== 'ENOENT') throw error; });
          size = 0;
        }
        const batch = lines.join('');
        await appendFile(file, batch, { encoding: 'utf8', mode: 0o600 });
        size += bytes;
      }
    } catch { this.failed = true; this.pending.length = 0; this.warn(); }
    finally { this.draining = undefined; }
  }
  snapshot() {
    return {
      confirmed: this.confirmed,
      recoverySubmitted: this.recoverySubmitted,
      events: this.recent.map(event => ({ ...event })).reverse(),
      logging: { enabled: Boolean(this.directory), healthy: !this.failed, retained: this.recent.length, limit: 100 },
    };
  }
  async close(): Promise<void> { this.closed = true; await this.draining; }
}
