import type { Settings } from './config.js';

export interface RepeatEvidence { period: number; repeats: number; coverage: number; novelty: number; score: number; confirmed: boolean; chars: number }

/** Exact suffix periodicity plus window overlap. Scores are heuristics, not probabilities. */
export function periodicSuffix(text: string, minPeriod: number, maxPeriod: number, minRepeats: number) {
  let best = { period: 0, repeats: 0, coverage: 0 };
  for (let period = minPeriod; period <= Math.min(maxPeriod, Math.floor(text.length / minRepeats)); period++) {
    const end = text.length, unit = text.slice(end - period);
    // Short Chinese phrases can have fewer than six distinct characters.
    // Require two different letters (including CJK), rather than alphabet size;
    // punctuation, numeric-only and single-character runs remain unconfirmed.
    if (new Set(unit.match(/\p{L}/gu) ?? []).size < 2) continue;
    let matched = period;
    while (matched < end && text.charCodeAt(end - 1 - matched) === text.charCodeAt(end - 1 - (matched % period))) matched++;
    const repeats = Math.floor(matched / period), coverage = matched / text.length;
    if (repeats >= minRepeats && coverage > best.coverage) best = { period, repeats, coverage };
  }
  return best;
}
export function grams(text: string): Set<string> {
  const set = new Set<string>();
  // Include every offset so odd-sized stream deltas cannot make an unchanged
  // periodic window appear wholly novel by switching the sampling parity.
  for (let i = 0; i + 4 <= text.length; i++) set.add(text.slice(i, i + 4));
  return set;
}
export function codeLike(text: string): boolean {
  return /^ {0,3}(?:```|~~~)/m.test(text) || ((text.match(/[{};=<>]/g)?.length ?? 0) / Math.max(text.length, 1) > 0.08);
}
export class RepeatDetector {
  private buffer = '';
  private total = 0;
  private sinceCheck = 0;
  private previous = new Set<string>();
  private consecutive = 0;
  private lastConfirmedPeriod = 0;
  constructor(private readonly config: Settings) {}
  push(text: string): RepeatEvidence | undefined {
    this.total += text.length;
    this.sinceCheck += text.length;
    this.buffer = (this.buffer + text).slice(-this.config.windowChars);
    if (this.total < this.config.minChars || this.sinceCheck < this.config.checkEveryChars) return;
    this.sinceCheck = 0;
    const current = grams(this.buffer.slice(-1024));
    let fresh = 0; for (const gram of current) if (!this.previous.has(gram)) fresh++;
    const novelty = this.previous.size ? fresh / Math.max(current.size, 1) : 1;
    this.previous = current;
    const repeat = periodicSuffix(this.buffer, this.config.minPeriod, this.config.maxPeriod, this.config.minRepeats);
    const strong = repeat.coverage >= 0.85 && !codeLike(this.buffer);
    // Confirmation requires fresh characters on distinct checks, never repeated checks of one buffer.
    const compatiblePeriod = this.lastConfirmedPeriod === 0 || repeat.period % this.lastConfirmedPeriod === 0 || this.lastConfirmedPeriod % Math.max(repeat.period, 1) === 0;
    const stable = strong && novelty <= 0.15;
    this.consecutive = stable && compatiblePeriod ? this.consecutive + 1 : stable ? 1 : 0;
    this.lastConfirmedPeriod = stable ? repeat.period : 0;
    if (repeat.repeats === 0) return;
    const score = strong ? (novelty <= 0.15 ? 98 : 85) : Math.round(40 + 35 * repeat.coverage);
    return { ...repeat, novelty, score, confirmed: strong && novelty <= 0.15 && this.consecutive >= this.config.confirmations, chars: this.total };
  }
}
