import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../dist/core.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/benchmark-detection.mjs <baseline-dist-directory>');
const baseline = Object.assign({}, ...await Promise.all(['detection.js', 'monitor.js', 'config.js'].map(file => import(pathToFileURL(resolve(process.argv[2], file)).href))));
let seed = 0x5eed1234;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const alphabet = ['a', 'b', 'c', '甲', '乙', '𐐀', '𐐁', ' ', '.', '!', '\n', '0', '。'];
const cases = [];
for (let i = 0; i < 10000; i++) {
  const unit = Array.from({ length: 1 + random(100) }, () => alphabet[random(alphabet.length)]).join('');
  const prefix = Array.from({ length: random(100) }, () => alphabet[random(alphabet.length)]).join('');
  const text = (prefix + unit.repeat(1 + random(100))).slice(-4096 - random(16));
  const min = 8 + random(32), max = min + random(512 - min), repeats = 4 + random(5);
  cases.push([text, min, max, repeats]);
}
for (const unit of ['好。执行。好。', 'Write. / Output. / Let me write.', 'a!', '𐐀!', '𐐀!𐐁?']) {
  for (let offset = 0; offset < unit.length; offset++) {
    cases.push([unit.repeat(1000).slice(offset, offset + 4096), 16, 512, 6]);
    cases.push([('ordinary preamble. ' + unit.repeat(1000)).slice(0, 4096 + offset), 16, 512, 6]);
  }
}
for (const input of cases) assert.deepEqual(current.periodicSuffix(...input), baseline.periodicSuffix(...input));
console.log(`Equivalent periodic suffix results: ${cases.length} cases`);

const periodic = '好。执行。好。'.repeat(1000).slice(-4096);
const longLoop = '好。执行。好。'.repeat(40000).slice(0, 262144);
const changing = Array.from({ length: 200 }, (_, i) => `Step ${i}: check candidate ${i * i}, then inspect file-${i.toString(36)}.\n`).join('').slice(-4096);
const workloads = {
  'periodic-suffix': module => module.periodicSuffix(periodic, 16, 512, 6),
  'changing-suffix': module => module.periodicSuffix(changing, 16, 512, 6),
  'stream-256k-single-delta': module => {
    const events = [];
    const monitor = new module.StreamMonitor(module.defaults, event => events.push(event));
    monitor.push({ type: 'reasoning-delta', index: 0, text: longLoop });
    return events;
  },
  'stream-256k-73-char-deltas': module => {
    const events = [];
    const monitor = new module.StreamMonitor(module.defaults, event => events.push(event));
    for (let offset = 0; offset < longLoop.length; offset += 73) monitor.push({ type: 'reasoning-delta', index: 0, text: longLoop.slice(offset, offset + 73) });
    return events;
  },
};
function measure(run, module, count) {
  const start = performance.now();
  for (let i = 0; i < count; i++) run(module);
  return (performance.now() - start) / count;
}
for (const [name, run] of Object.entries(workloads)) {
  assert.deepEqual(run(current), run(baseline), `${name}: evidence unchanged`);
  const count = name.startsWith('stream') ? 2 : 500;
  run(baseline); run(current);
  const before = [], after = [];
  for (let round = 0; round < 5; round++) {
    for (const [module, times] of round % 2 ? [[current, after], [baseline, before]] : [[baseline, before], [current, after]]) times.push(measure(run, module, count));
  }
  const median = samples => samples.sort((a, b) => a - b)[2];
  const baselineMs = median(before), optimizedMs = median(after);
  console.log(JSON.stringify({ workload: name, baselineMs, optimizedMs, ratio: baselineMs / optimizedMs, evidenceEqual: true }));
}
