import type { Settings } from './config.js';

export interface RepeatEvidence { method?: 'periodic' | 'phrase'; period: number; repeats: number; coverage: number; novelty: number; score: number; confirmed: boolean; chars: number }

/** Repeated short units can alternate with changing remarks, defeating exact periods. */
export function phraseRepetition(text: string, minRepeats: number) {
  const units = [...text.matchAll(/[^。！？!?;；\n\r/.()（）]+/gu)].map(match => ({
    value: match[0].trim().toLowerCase(), start: match.index!,
  })).filter(unit => unit.value.length > 0);
  const counts = new Map<string, number>();
  for (const { value } of units) {
    if (value.length <= 24 && /\p{L}/u.test(value) && !/\p{N}/u.test(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const common = [...counts].filter(([, count]) => count >= minRepeats).sort((a, b) => b[1] * b[0].length - a[1] * a[0].length).slice(0, 4);
  const values = new Set(common.map(([value]) => value));
  if (new Set(common.map(([value]) => value).join('').match(/\p{L}/gu)).size < 2) return;
  const repeated = units.filter(unit => values.has(unit.value));
  const chars = units.reduce((sum, unit) => sum + unit.value.replace(/\s/gu, '').length, 0);
  const repeatedChars = repeated.reduce((sum, unit) => sum + unit.value.replace(/\s/gu, '').length, 0);
  const coverage = repeated.length / Math.max(units.length, 1);
  // Require the repeated units throughout the window, not a quotation in one corner.
  const distributed = [0, 1, 2].every(third => repeated.filter(unit => unit.start >= text.length * third / 3 && unit.start < text.length * (third + 1) / 3).length >= 3);
  if (repeated.length < 24 || repeatedChars < 80 || repeatedChars / Math.max(chars, 1) < 0.35 || coverage < 0.7 || !distributed) return;
  return { period: 0, repeats: repeated.length, coverage };
}

/** Exact suffix periodicity plus window overlap. Scores are heuristics, not probabilities. */
export function periodicSuffix(text: string, minPeriod: number, maxPeriod: number, minRepeats: number) {
  let best = { period: 0, repeats: 0, coverage: 0 };
  const end = text.length, limit = Math.min(maxPeriod, Math.floor(end / minRepeats));
  if (limit < minPeriod) return best;
  // A suffix contains two distinct letters exactly when it includes the last
  // letter before the final run of identical letters. Scan Unicode only once.
  let lastLetter = '', lastIndex = -1, distinctIndex = -1;
  for (const match of text.slice(end - limit).matchAll(/\p{L}/gu)) {
    if (match[0] !== lastLetter) distinctIndex = lastIndex;
    lastLetter = match[0]; lastIndex = match.index;
  }
  if (distinctIndex < 0) return best;
  for (let period = Math.max(minPeriod, limit - distinctIndex); period <= limit; period++) {
    let matched = period;
    while (matched < end && text.charCodeAt(end - 1 - matched) === text.charCodeAt(end - 1 - matched + period)) matched++;
    const repeats = Math.floor(matched / period), coverage = matched / text.length;
    if (repeats >= minRepeats && coverage > best.coverage) best = { period, repeats, coverage };
    if (best.coverage === 1) break;
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
  private previousPhrase = new Set<string>();
  private consecutive = 0;
  private lastConfirmedPeriod = 0;
  private phraseConsecutive = 0;
  private checks = 0;
  stats() { return { chars: this.total, checks: this.checks }; }
  constructor(private readonly config: Settings, private readonly reasoning = false) {}
  push(text: string): RepeatEvidence | undefined {
    this.total += text.length;
    this.sinceCheck += text.length;
    this.buffer = (this.buffer + text).slice(-this.config.windowChars);
    if (this.total < (this.reasoning ? Math.min(512, this.config.minChars) : this.config.minChars) || this.sinceCheck < (this.reasoning ? Math.min(128, this.config.checkEveryChars) : this.config.checkEveryChars)) return;
    this.sinceCheck = 0;
    this.checks++;
    const current = grams(this.buffer.slice(-1024));
    let fresh = 0; for (const gram of current) if (!this.previous.has(gram)) fresh++;
    const novelty = this.previous.size ? fresh / Math.max(current.size, 1) : 1;
    this.previous = current;
    const phraseGrams = this.reasoning ? grams(this.buffer.slice(-512)) : new Set<string>();
    let phraseFresh = 0; for (const gram of phraseGrams) if (!this.previousPhrase.has(gram)) phraseFresh++;
    const phraseNovelty = this.previousPhrase.size ? phraseFresh / Math.max(phraseGrams.size, 1) : 1;
    this.previousPhrase = phraseGrams;
    const repeat = this.total >= this.config.minChars ? periodicSuffix(this.buffer, this.config.minPeriod, this.config.maxPeriod, this.config.minRepeats) : { period: 0, repeats: 0, coverage: 0 };
    const strong = repeat.coverage >= 0.85 && !codeLike(this.buffer);
    // Confirmation requires fresh characters on distinct checks, never repeated checks of one buffer.
    const compatiblePeriod = this.lastConfirmedPeriod === 0 || repeat.period % this.lastConfirmedPeriod === 0 || this.lastConfirmedPeriod % Math.max(repeat.period, 1) === 0;
    const stable = strong && novelty <= 0.15;
    this.consecutive = stable && compatiblePeriod ? this.consecutive + 1 : stable ? 1 : 0;
    this.lastConfirmedPeriod = stable ? repeat.period : 0;
    const phrase = this.reasoning && !codeLike(this.buffer.slice(-512)) ? phraseRepetition(this.buffer.slice(-512), this.config.minRepeats) : undefined;
    const phraseStable = !!phrase && phrase.coverage >= 0.75 && phraseNovelty <= 0.45;
    this.phraseConsecutive = phraseStable ? this.phraseConsecutive + 1 : 0;
    if (phrase && (!repeat.repeats || this.phraseConsecutive >= this.config.confirmations)) return {
      ...phrase, method: 'phrase', novelty: phraseNovelty, score: phraseStable ? 96 : 75,
      confirmed: this.phraseConsecutive >= this.config.confirmations, chars: this.total,
    };
    if (repeat.repeats === 0) return;
    const score = strong ? (novelty <= 0.15 ? 98 : 85) : Math.round(40 + 35 * repeat.coverage);
    return { ...repeat, method: 'periodic', novelty, score, confirmed: strong && novelty <= 0.15 && this.consecutive >= this.config.confirmations, chars: this.total };
  }
}
