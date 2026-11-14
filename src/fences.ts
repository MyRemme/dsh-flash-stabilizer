type Marker = '' | '`' | '~';

/** Streaming fenced-code filter with bounded state, including across deltas. */
export class FenceFilter {
  private fence: Marker = '';
  private fenceLength = 0;
  private phase: 'indent' | 'run' | 'info' | 'tail' | 'body' = 'indent';
  private prefix = '';
  private marker: Marker = '';
  private runLength = 0;
  private skipLF = false;
  private limited = false;
  constructor(private readonly onLimit: () => void = () => {}) {}
  private append(ch: string): boolean {
    // An opener cannot be classified until its info string ends or contains a
    // backtick. Bound that undecided line instead of silently dropping text.
    if (this.prefix.length + ch.length > 65536) {
      this.prefix = ''; this.limited = true; this.onLimit(); return false;
    }
    this.prefix += ch; return true;
  }

  /** Returning false from emit abandons parsing; discard this filter afterward. */
  push(text: string, emit: (text: string) => boolean | void, boundary: () => boolean | void): void {
    if (this.limited) return;
    for (const ch of text) {
      if (this.skipLF) { this.skipLF = false; if (ch === '\n') continue; }
      if (ch === '\n' || ch === '\r') {
        if (!this.fence) {
          if (this.phase === 'run' && this.runLength >= 3 || this.phase === 'info') {
            this.fence = this.marker; this.fenceLength = this.runLength;
            this.skipLF = ch === '\r';
            if (boundary() === false) return;
          } else if (this.phase === 'indent' || this.phase === 'run' && this.runLength < 3) { if (emit(this.prefix + ch) === false) return; }
          else if (this.phase === 'body' && emit(ch) === false) return;
        } else if (this.marker === this.fence && this.runLength >= this.fenceLength
          && (this.phase === 'run' || this.phase === 'tail')) {
          this.fence = ''; this.fenceLength = 0; this.skipLF = ch === '\r';
          if (boundary() === false) return;
        }
        this.phase = 'indent'; this.prefix = ''; this.marker = ''; this.runLength = 0;
        continue;
      }
      if (this.phase === 'indent') {
        if (ch === ' ' && this.prefix.length < 3) { this.prefix += ch; continue; }
        if ((ch === '`' || ch === '~') && (!this.fence || ch === this.fence)) {
          this.marker = ch; this.runLength = 1; this.phase = 'run';
          if (!this.fence) this.prefix += ch;
          continue;
        }
        this.phase = 'body';
        if (!this.fence && emit(this.prefix + ch) === false) return;
        this.prefix = '';
      } else if (this.phase === 'run') {
        if (ch === this.marker) {
          this.runLength++;
          if (!this.fence && !this.append(ch)) return;
        } else if (this.fence) {
          this.phase = this.runLength >= this.fenceLength && (ch === ' ' || ch === '\t') ? 'tail' : 'body';
        } else if (this.runLength >= 3) {
          this.phase = 'info';
          if (!this.append(ch)) return;
        } else {
          this.phase = 'body';
          if (emit(this.prefix + ch) === false) return;
          this.prefix = '';
        }
      } else if (this.phase === 'info') {
        if (this.marker === '`' && ch === '`') {
          this.phase = 'body';
          if (emit(this.prefix + ch) === false) return;
          this.prefix = '';
        } else if (!this.append(ch)) return;
      } else if (this.phase === 'tail') {
        if (ch !== ' ' && ch !== '\t') this.phase = 'body';
      } else if (!this.fence && emit(ch) === false) return;
    }
  }

  finish(emit: (text: string) => void): void {
    if (!this.limited && !this.fence && (this.phase === 'indent' || this.phase === 'run' && this.runLength < 3)) emit(this.prefix);
    this.prefix = '';
  }
}
