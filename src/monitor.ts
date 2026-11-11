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
  constructor(private readonly config: Settings, private readonly report: (e: RepeatEvidence & { contentType: 'reasoning' | 'text' }) => void) {}
  push(chunk: Chunk): void {
    if (this.reported) return;
    if (chunk.type === 'finish') { this.blocks.clear(); return; }
    if (!['block-start', 'reasoning-delta', 'text-delta', 'block-end'].includes(chunk.type) || !Number.isSafeInteger(chunk.index)) return;
    const index = chunk.index!;
    let block = this.blocks.get(index);
    if (!block) {
      if (this.blocks.size >= 32) return;
      block = {
        detector: new RepeatDetector(this.config),
        type: chunk.blockType ?? chunk.block?.type ?? (chunk.type === 'reasoning-delta' ? 'reasoning' : 'text'),
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
      return;
    }
    if (typeof chunk.text !== 'string' || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return;
    if (chunk.text.length > 0) block.seen = true;
    this.feed(block, chunk.text);
  }
  private feed(block: BlockState, text: string): void {
    let plain = '';
    const flush = () => { if (plain) this.inspect(block, plain); plain = ''; return !this.reported; };
    block.filter.push(text, segment => {
      plain += segment;
      if (plain.length >= this.config.checkEveryChars) return flush();
    }, () => { plain = ''; block.detector = new RepeatDetector(this.config); });
    flush();
  }
  private inspect(block: BlockState, text: string): void {
    for (let offset = 0; !this.reported && offset < text.length; offset += this.config.checkEveryChars) {
      const result = block.detector.push(text.slice(offset, offset + this.config.checkEveryChars));
      if (result && !this.reported) {
        // Suspicion stays observable; only one confirmed incident per attempt.
        if (result.confirmed) { this.reported = true; this.blocks.clear(); }
        this.report({ ...result, contentType: block.type === 'reasoning' ? 'reasoning' : 'text' });
      }
    }
  }
}
