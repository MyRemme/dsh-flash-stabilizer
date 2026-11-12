import type { Settings } from './config.js';
import { RepeatDetector, type RepeatEvidence } from './detection.js';
import type { Chunk } from './types.js';
import { FenceFilter } from './fences.js';

interface BlockState {
  detector: RepeatDetector;
  type: string;
  filter: FenceFilter;
  closed: boolean;
  seen: boolean;
}
/** One instance per model attempt. Provider chunks are never modified. */
export class StreamMonitor {
  private blocks = new Map<number, BlockState>();
  private reported = false;
  private outputBlocks = new Map<number, { seen: boolean; closed: boolean }>();
  private reasoningChars = 0;
  private textChars = 0;
  private analyzedChars = 0;
  private checks = 0;
  private closed = new Set<number>();
  private incomplete = false;
  private lastOutputAt: string | null = null;
  private lastCheckAt: string | null = null;
  private evidence: (RepeatEvidence & { contentType: 'reasoning' | 'text' }) | null = null;
  snapshot() {
    return { reasoningChars: this.reasoningChars, textChars: this.textChars, analyzedChars: this.analyzedChars, checks: this.checks,
      lastOutputAt: this.lastOutputAt, lastCheckAt: this.lastCheckAt,
      incomplete: this.incomplete,
      risk: this.reported ? 'confirmed' as const : this.evidence && this.evidence.score >= 70 ? 'suspected' as const : this.incomplete ? 'incomplete' as const : this.checks ? 'clear' as const : 'collecting' as const,
      evidence: this.evidence ? { ...this.evidence } : null };
  }
  constructor(private readonly config: Settings, private readonly report: (e: RepeatEvidence & { contentType: 'reasoning' | 'text' }) => void) {}
  push(chunk: Chunk): void {
    if (Number.isSafeInteger(chunk.index) && this.closed.has(chunk.index!)) return;
    // Lightweight counters keep advancing after confirmation; never restart scanning.
    this.countOutput(chunk);
    if (chunk.type === 'block-end' && Number.isSafeInteger(chunk.index)) {
      if (this.closed.size < 65536) this.closed.add(chunk.index!); else this.incomplete = true;
      this.outputBlocks.delete(chunk.index!);
    }
    if (this.reported) return;
    if (chunk.type === 'finish') { this.blocks.clear(); return; }
    if (!['block-start', 'reasoning-delta', 'text-delta', 'block-end'].includes(chunk.type) || !Number.isSafeInteger(chunk.index)) return;
    const index = chunk.index!;
    let block = this.blocks.get(index);
    if (!block) {
      if (this.blocks.size >= 32 || this.incomplete) { this.incomplete = true; return; }
      const type = chunk.blockType ?? chunk.block?.type ?? (chunk.type === 'reasoning-delta' ? 'reasoning' : 'text');
      block = {
        detector: new RepeatDetector(this.config, type === 'reasoning'), type,
        filter: new FenceFilter(), closed: false, seen: false,
      };
      this.blocks.set(index, block);
    }
    if (block.closed) return;
    if (chunk.type === 'block-end') {
      // Adapters may emit only block-end; don't count text twice after deltas.
      if (!block.seen && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning')) this.feed(block, chunk.block.text ?? '');
      if (!this.reported) block.filter.finish(text => this.inspect(block!, text));
      block.closed = true;
      this.blocks.delete(index);
      return;
    }
    if (typeof chunk.text !== 'string' || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return;
    if (chunk.text.length > 0) block.seen = true;
    this.feed(block, chunk.text);
  }
  private countOutput(chunk: Chunk): void {
    if (chunk.type === 'finish') { this.outputBlocks.clear(); return; }
    if (!Number.isSafeInteger(chunk.index) || !['block-start', 'reasoning-delta', 'text-delta', 'block-end'].includes(chunk.type)) return;
    let block = this.outputBlocks.get(chunk.index!);
    if (!block) {
      if (this.outputBlocks.size >= 32 || this.incomplete) { this.incomplete = true; return; }
      block = { seen: false, closed: false }; this.outputBlocks.set(chunk.index!, block);
    }
    if (block.closed) return;
    let type: string | undefined, length = 0;
    if ((chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') && typeof chunk.text === 'string') {
      type = chunk.type === 'reasoning-delta' ? 'reasoning' : 'text'; length = chunk.text.length; block.seen ||= length > 0;
    } else if (chunk.type === 'block-end') {
      if (!block.seen && typeof chunk.block?.text === 'string') { type = chunk.block.type; length = chunk.block.text.length; }
      block.closed = true;
    }
    if (length && (type === 'reasoning' || type === 'text')) {
      if (type === 'reasoning') this.reasoningChars += length; else this.textChars += length;
      this.lastOutputAt = new Date().toISOString();
    }
  }
  private feed(block: BlockState, text: string): void {
    let plain = '';
    const flush = () => { if (plain) this.inspect(block, plain); plain = ''; return !this.reported; };
    block.filter.push(text, segment => {
      plain += segment;
      if (plain.length >= this.config.checkEveryChars) return flush();
    }, () => { plain = ''; block.detector = new RepeatDetector(this.config, block.type === 'reasoning'); });
    flush();
  }
  private inspect(block: BlockState, text: string): void {
    const interval = block.type === 'reasoning' ? Math.min(128, this.config.checkEveryChars) : this.config.checkEveryChars;
    for (let offset = 0; !this.reported && offset < text.length; offset += interval) {
      const before = block.detector.stats(), part = text.slice(offset, offset + interval);
      const result = block.detector.push(part), after = block.detector.stats();
      this.analyzedChars += part.length;
      if (after.checks > before.checks) {
        this.checks += after.checks - before.checks; this.lastCheckAt = new Date().toISOString();
        this.evidence = result ? { ...result, contentType: block.type === 'reasoning' ? 'reasoning' : 'text' } : null;
      }
      if (result && !this.reported) {
        // Suspicion stays observable; only one confirmed incident per attempt.
        if (result.confirmed) { this.reported = true; this.blocks.clear(); }
        this.report({ ...result, contentType: block.type === 'reasoning' ? 'reasoning' : 'text' });
      }
    }
  }
}
