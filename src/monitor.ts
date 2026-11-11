import type { Settings } from './config.js';
import { RepeatDetector, type RepeatEvidence } from './detection.js';
import type { Chunk } from './types.js';

interface BlockState { detector: RepeatDetector; type: string; fence: boolean; tail: string; closed: boolean; seen: boolean }
/** One instance per model attempt. Provider chunks are never modified. */
export class StreamMonitor {
  private blocks = new Map<number, BlockState>();
  private reported = false;
  constructor(private readonly config: Settings, private readonly report: (e: RepeatEvidence) => void) {}
  push(chunk: Chunk): void {
    if (chunk.type === 'finish') { this.blocks.clear(); return; }
    if (!['block-start', 'reasoning-delta', 'text-delta', 'block-end'].includes(chunk.type) || !Number.isSafeInteger(chunk.index)) return;
    const index = chunk.index!;
    let block = this.blocks.get(index);
    if (!block) {
      if (this.blocks.size >= 32) return;
      block = { detector: new RepeatDetector(this.config), type: chunk.blockType ?? chunk.block?.type ?? (chunk.type === 'reasoning-delta' ? 'reasoning' : 'text'), fence: false, tail: '', closed: false, seen: false };
      this.blocks.set(index, block);
    }
    if (block.closed) return;
    if (chunk.type === 'block-end') {
      // Adapters may emit only block-end; don't count text twice after deltas.
      if (!block.seen && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning')) this.feed(block, chunk.block.text ?? '');
      block.closed = true;
      return;
    }
    if (typeof chunk.text !== 'string' || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return;
    block.seen = true;
    this.feed(block, chunk.text);
  }
  private feed(block: BlockState, text: string): void {
    // Process bounded pieces so a giant provider chunk cannot skip independent checks.
    for (let offset = 0; offset < text.length; offset += this.config.checkEveryChars) {
      const piece = text.slice(offset, offset + this.config.checkEveryChars);
      const withTail = block.tail + piece;
      const marks = [...withTail.matchAll(/```|~~~/g)];
      const fences = marks.length;
      const wasFenced = block.fence;
      if (fences % 2) block.fence = !block.fence;
      const lastMark = marks.at(-1);
      const unconsumed = lastMark ? withTail.slice(lastMark.index + 3) : withTail;
      block.tail = /[`~]{1,2}$/.exec(unconsumed)?.[0] ?? '';
      if (wasFenced || block.fence || fences) {
        block.detector = new RepeatDetector(this.config);
        continue;
      }
      const result = block.detector.push(piece);
      if (result && !this.reported) {
        // Suspicion stays observable; only one confirmed incident per attempt.
        if (result.confirmed) this.reported = true;
        this.report(result);
      }
    }
  }
}
