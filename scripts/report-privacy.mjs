// Publication helpers only. Never rewrite the private source evidence or hashes.
const publicModels = new Set(['deepseek-flash', 'deepseek-v4-pro']);
export function publicModelName(value) {
  const suffix = typeof value === 'string' ? value.split(/[/:]/).at(-1) : undefined;
  return publicModels.has(suffix) ? suffix : '[model-redacted]';
}
export function modelProvenance(models) {
  if (!models.length || models.some(m => typeof m !== 'string' || !m)) throw Error('Missing wire model evidence');
  const names = [...new Set(models.map(publicModelName))];
  return {
    source: 'Saved HTTP request model fields; provider connection confirmed by user',
    requestsAudited: models.length, publicNames: names,
    localRouteRedacted: models.some(m => m !== publicModelName(m)),
    exactWireModelPublished: models.every(m => m === publicModelName(m)),
    // A configured alias or response label cannot establish a weight revision.
    serverWeightRevisionVerified: false,
  };
}
export function sanitizeReport(value, key = '') {
  if (value === null || value === undefined) return value;
  if (/^(?:model|responseModel|requestModel)$/i.test(key)) return publicModelName(value);
  if (/^provider$/i.test(key)) return '[provider-route-redacted]';
  if (Array.isArray(value)) return value.map(item => sanitizeReport(item, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeReport(v, k)]));
  if (typeof value === 'string') return value
    .replace(/\b[A-Z]:[/\\]+[^\s"'`<>]*/gi, '[local-path-redacted]')
    .replace(/\/(?:Users|home)\/[^\s"'`<>]+/g, '[local-path-redacted]');
  return value;
}
