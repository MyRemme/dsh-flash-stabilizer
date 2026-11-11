import { describe, expect, it } from 'vitest';
import { modelProvenance, publicModelName, sanitizeReport } from '../scripts/report-privacy.mjs';

describe('published evidence privacy', () => {
  it('redacts nested local model/provider routes without modifying private evidence or hashes', () => {
    const original = {
      model: 'fixture/nested/deepseek-flash', provider: 'fixture-provider',
      manifest: { model: 'fixture:deepseek-flash', results: [{ audits: [{ model: 'fixture/deepseek-flash', bodySha256: 'unchanged-hash' }] }] },
      responseModel: 'fixture/private-weight', requestModel: null,
      diagnostic: 'Read C:\\Users\\Example\\private\\request.json and /home/example/private/data.json',
      path: '.compat-cache/run/request.json', source: 'https://api-docs.deepseek.com/guides/thinking_mode/',
    };
    const result = sanitizeReport(original);
    expect(result.model).toBe('deepseek-flash');
    expect(result.provider).toBe('[provider-route-redacted]');
    expect(result.manifest.results[0].audits[0]).toEqual({ model: 'deepseek-flash', bodySha256: 'unchanged-hash' });
    expect(result.responseModel).toBe('[model-redacted]');
    expect(result.requestModel).toBeNull();
    expect(result.diagnostic).toBe('Read [local-path-redacted] and [local-path-redacted]');
    expect(result.path).toBe(original.path);
    expect(result.source).toBe(original.source);
    expect(original.model).toBe('fixture/nested/deepseek-flash');
  });
  it('distinguishes a redacted identity from the exact HTTP model field', () => {
    expect(modelProvenance(['fixture/deepseek-flash', 'fixture/deepseek-flash'])).toMatchObject({
      requestsAudited: 2, publicNames: ['deepseek-flash'], localRouteRedacted: true,
      exactWireModelPublished: false, serverWeightRevisionVerified: false,
    });
    expect(modelProvenance(['deepseek-flash'])).toMatchObject({ localRouteRedacted: false, exactWireModelPublished: true });
    expect(() => modelProvenance([])).toThrow();
    expect(() => modelProvenance([undefined])).toThrow();
    expect(publicModelName('fixture/private-weight')).toBe('[model-redacted]');
  });
});
