import { describe, expect, it } from 'vitest';
import { ProgressGuard, fingerprint } from '../src/progress.js';
describe('tool evidence', () => {
  it('canonicalizes key order without changing command or path semantics', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(fingerprint({ path: 'A.ts' })).not.toBe(fingerprint({ path: 'a.ts' }));
    expect(fingerprint({ command: 'echo $X' })).not.toBe(fingerprint({ command: 'echo $x' }));
  });
  it('counts settled equal results, and resets on changed evidence or expiry', () => {
    let time = 0; const guard = new ProgressGuard(4, () => time);
    const exec = { name: 'test', arguments: { command: 'pytest' } }, result = { isError: true, content: 'failure' };
    for (let i = 0; i < 3; i++) expect(guard.record(exec, result).repeated).toBe(false);
    expect(guard.record(exec, result)).toMatchObject({ repeated: true, count: 4, failed: true });
    expect(guard.record(exec, { isError: false, content: 'passed' })).toMatchObject({ repeated: false, count: 1, codeEvidence: 'changed-output' });
    time = 300001;
    expect(guard.record(exec, { isError: false, content: 'passed' }).count).toBe(1);
  });
  it('handles special JSON keys and bounds pathological input', () => {
    expect(fingerprint(JSON.parse('{"__proto__":{"x":1},"constructor":1}'))).not.toBe(fingerprint({}));
    const circular: unknown[] = []; circular.push(circular);
    expect(() => fingerprint(circular)).toThrow();
  });
  it('skips bounded-out results and breaks the repetition chain across unobserved output', () => {
    const guard = new ProgressGuard(4), exec = { name: 'read', arguments: { path: 'fixture' } };
    const normal = { isError: false, content: 'same evidence' };
    for (let i = 0; i < 3; i++) guard.record(exec, normal);
    expect(guard.record(exec, { isError: false, value: Array.from({ length: 20001 }, (_, i) => i) })).toMatchObject({ repeated: false });
    expect(guard.record(exec, normal)).toMatchObject({ repeated: false, count: 1 });
    const deep: unknown[] = []; let cursor = deep;
    for (let i = 0; i < 40; i++) { const next: unknown[] = []; cursor.push(next); cursor = next; }
    expect(guard.record({ ...exec, arguments: deep }, normal).repeated).toBe(false);
    expect(guard.record(exec, normal).count).toBe(1);
  });
  it('does not swallow unexpected fingerprinting failures', () => {
    const result = { isError: false, get content(): string { throw new TypeError('fixture failure'); } };
    expect(() => new ProgressGuard(4).record({ name: 'read', arguments: {} }, result)).toThrow(TypeError);
  });
});
