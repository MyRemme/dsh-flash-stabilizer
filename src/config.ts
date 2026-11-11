export interface Settings {
  enabled: boolean;
  mode: 'observe' | 'assist' | 'auto';
  models: string[];
  providers: string[];
  disabledSessions: string[];
  windowChars: number;
  minChars: number;
  checkEveryChars: number;
  minPeriod: number;
  maxPeriod: number;
  minRepeats: number;
  confirmations: number;
  toolRepeatLimit: number;
  maxRecoveries: number;
  maxSessions: number;
  logDir: string;
  maxLogBytes: number;
  hostVersion: string;
  language: 'zh' | 'en';
}
export const defaults: Settings = {
  enabled: true, mode: 'observe', models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
  providers: [], disabledSessions: [], windowChars: 4096, minChars: 1536, checkEveryChars: 256,
  minPeriod: 16, maxPeriod: 512, minRepeats: 6, confirmations: 3,
  toolRepeatLimit: 4, maxRecoveries: 2, maxSessions: 128,
  logDir: '', maxLogBytes: 2_097_152, hostVersion: '', language: 'zh',
};
export function resolveSettings(input: unknown = {}): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('config must be an object');
  const supplied = input as Record<string, unknown>;
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(defaults, key)) throw new TypeError(`unknown config: ${key}`);
  const result = { ...defaults, ...supplied } as Settings;
  for (const key of ['models', 'providers', 'disabledSessions'] as const) {
    const value = result[key];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new TypeError(`${key}: expected non-empty strings`);
    result[key] = [...value];
  }
  for (const key of ['windowChars', 'minChars', 'checkEveryChars', 'minPeriod', 'maxPeriod', 'minRepeats', 'confirmations', 'toolRepeatLimit', 'maxRecoveries', 'maxSessions', 'maxLogBytes'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'maxRecoveries' ? 0 : 1)) throw new TypeError(`${key}: expected positive integer`);
  }
  if (result.windowChars > 16384 || result.windowChars < 512 || result.minChars < 512 || result.minChars > result.windowChars) throw new TypeError('require 512 <= minChars <= windowChars <= 16384');
  if (result.checkEveryChars < 64 || result.maxPeriod > 1024 || result.minPeriod < 8 || result.minPeriod > result.maxPeriod || result.maxPeriod * result.minRepeats > result.windowChars) throw new TypeError('invalid repeat window/period/check interval');
  if (result.minRepeats < 4 || result.confirmations < 2 || result.toolRepeatLimit < 3 || result.maxRecoveries > 2 || result.maxSessions > 1024 || result.maxLogBytes < 4096 || result.maxLogBytes > 16_777_216) throw new TypeError('unsafe or excessive limits');
  if (!['observe', 'assist', 'auto'].includes(result.mode) || !['zh', 'en'].includes(result.language)) throw new TypeError('invalid mode or language');
  if (typeof result.enabled !== 'boolean' || typeof result.logDir !== 'string' || typeof result.hostVersion !== 'string') throw new TypeError('invalid enabled/logDir/hostVersion');
  return result;
}
/** Standard Schema is supported by both old and current vendored Cordis. */
export const Config = {
  '~standard': {
    version: 1 as const, vendor: 'dsh-flash-stabilizer',
    validate(value: unknown): { value: Settings } | { issues: { message: string }[] } {
      try { return { value: resolveSettings(value) }; }
      catch (error) { return { issues: [{ message: error instanceof Error ? error.message : 'invalid config' }] }; }
    },
  },
};
