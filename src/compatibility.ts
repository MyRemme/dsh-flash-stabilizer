import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

export interface ReleaseContract {
  version: string; tag: string; adapter: 'live-frames' | 'stream-waterfall';
  features: { lifecycle: string; stream: boolean; toolResult: boolean; assistantStream: boolean; [key: string]: boolean | string };
  hostTest: string; interventionVerified?: boolean;
}
const matrix = JSON.parse(readFileSync(new URL('../compatibility/releases.json', import.meta.url), 'utf8')) as { releases: ReleaseContract[] };
export const releases = matrix.releases;
export interface Compatibility {
  version: string; known: boolean; adapter: 'live-frames' | 'stream-waterfall'; lifecycle: string;
  intervention: boolean; reason: string;
}
/** Uses only package metadata, never loads another copy of a host service. */
export function detectHostVersion(): string | undefined {
  const require = createRequire(import.meta.url);
  const versions = new Set<string>();
  for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
    try { versions.add(JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version); } catch { /* Optional host metadata. */ }
  }
  return versions.size === 1 ? [...versions][0] : undefined;
}
export function compatibilityFor(version: string): Compatibility {
  const release = releases.find(r => r.version === version);
  const verified = release?.hostTest === 'passed' && release.interventionVerified === true;
  return {
    version: version || 'unknown', known: !!release, adapter: release?.adapter ?? 'stream-waterfall',
    lifecycle: release?.features.lifecycle ?? 'agent/created',
    intervention: !!verified,
    reason: !release ? 'unrecognized-host' : verified ? 'host-tests-passed' : 'automatic-intervention-not-verified',
  };
}
