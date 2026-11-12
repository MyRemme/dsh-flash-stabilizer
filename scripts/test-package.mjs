import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifact = resolve(process.argv[2] ?? join(root, `artifacts/${manifest.name}-${manifest.version}.tgz`));
const matrix = JSON.parse(await readFile(join(root, 'compatibility/releases.json'), 'utf8'));
const old = JSON.parse(await readFile(join(root, 'compatibility/host-results.json'), 'utf8'));
const listing = (await exec('tar', ['-tzf', artifact], { windowsHide: true })).stdout.trim().split(/\r?\n/);
assert.ok(listing.length > 0);
assert.ok(listing.every(p => p.startsWith('package/') && !p.split('/').includes('..') && !p.includes('\\')), 'safe archive paths');
for (const required of ['package/dist/index.js', 'package/client/client.js', 'package/cordis.patch.yml', 'package/README.md', 'package/compatibility/releases.json']) assert.ok(listing.includes(required), required);
assert.ok(listing.includes(`package/dist/runtime-${manifest.version}.js`), 'release-specific runtime entry');
assert.ok(!listing.some(p => /(?:^|\/)(?:\.npm-cache|\.compat-cache)(?:\/|$)/.test(p)), 'no development caches');
const runtimePackages = new Set(['semver', 'tar', 'chownr', 'minipass', 'minizlib', 'yallist', '@isaacs/fs-minipass']);
for (const entry of listing.filter(path => path.startsWith('package/node_modules/'))) {
  const path = entry.slice('package/node_modules/'.length).split('/');
  const name = path[0].startsWith('@') ? path.slice(0, 2).join('/') : path[0];
  assert.ok(runtimePackages.has(name), `Unexpected bundled dependency ${name}`);
  assert.ok(!entry.slice('package/node_modules/'.length).includes('/node_modules/'), 'no unreviewed nested dependency');
}
const results = []; let cursor = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < matrix.releases.length) {
    const { version } = matrix.releases[cursor++];
    const previous = old.results.find(r => r.version === version);
    if (previous?.status === 'unavailable') { results.push(previous); continue; }
    try {
      const runtime = join(root, '.compat-cache/runtimes', version);
      const installed = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh-agent-loop/package.json'), 'utf8'));
      assert.equal(installed.version, version);
      const directory = join(runtime, 'node_modules/dsh-flash-stabilizer');
      await mkdir(directory, { recursive: true });
      await exec('tar', ['-xzf', artifact, '-C', directory, '--strip-components=1'], { windowsHide: true });
      const { stdout } = await exec(process.execPath, [join(root, 'scripts/host-probe.mjs'), runtime, version, join(directory, `dist/runtime-${manifest.version}.js`)], { cwd: root, windowsHide: true, timeout: 45000 });
      results.push(JSON.parse(/PROBE_RESULT (.+)/.exec(stdout)[1]));
      console.log(`PASS packaged DSH ${version}`);
    } catch (error) {
      results.push({ version, status: 'failed', packaged: true, error: String(error).slice(-4000) });
      console.error(`FAIL packaged DSH ${version}: ${String(error).slice(-1500)}`);
    }
  }
}));
results.sort((a, b) => matrix.releases.findIndex(r => r.version === a.version) - matrix.releases.findIndex(r => r.version === b.version));
await writeFile(resolve(process.argv[3] ?? join(root, 'compatibility/host-results.json')), JSON.stringify({ testedAt: new Date().toISOString(), type: 'real-host-core-with-mock-provider', results }, null, 2) + '\n');
console.log(`Packaged host matrix: ${results.filter(r => r.status === 'passed').length} passed, ${results.filter(r => r.status === 'unavailable').length} unavailable, ${results.filter(r => r.status === 'failed').length} failed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
