import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = resolve(process.argv[2] ?? join(root, 'artifacts/dsh-flash-stabilizer-0.1.0.tgz'));
const matrix = JSON.parse(await readFile(join(root, 'compatibility/releases.json'), 'utf8'));
const old = JSON.parse(await readFile(join(root, 'compatibility/host-results.json'), 'utf8'));
const listing = (await exec('tar', ['-tzf', artifact], { windowsHide: true })).stdout.trim().split(/\r?\n/);
assert.ok(listing.length > 0);
assert.ok(listing.every(p => p.startsWith('package/') && !p.split('/').includes('..') && !p.includes('\\')), 'safe archive paths');
for (const required of ['package/dist/index.js', 'package/cordis.patch.yml', 'package/README.md', 'package/compatibility/releases.json']) assert.ok(listing.includes(required), required);
assert.ok(!listing.some(p => /(?:^|\/)(?:node_modules|\.npm-cache|\.compat-cache)(?:\/|$)/.test(p)), 'no development dependencies or caches');
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
      const { stdout } = await exec(process.execPath, [join(root, 'scripts/host-probe.mjs'), runtime, version, join(directory, 'dist/index.js')], { cwd: root, windowsHide: true, timeout: 45000 });
      results.push(JSON.parse(/PROBE_RESULT (.+)/.exec(stdout)[1]));
      console.log(`PASS packaged DSH ${version}`);
    } catch (error) {
      results.push({ version, status: 'failed', packaged: true, error: String(error).slice(-4000) });
      console.error(`FAIL packaged DSH ${version}: ${String(error).slice(-1500)}`);
    }
  }
}));
results.sort((a, b) => matrix.releases.findIndex(r => r.version === a.version) - matrix.releases.findIndex(r => r.version === b.version));
await writeFile(join(root, 'compatibility/host-results.json'), JSON.stringify({ testedAt: new Date().toISOString(), type: 'real-host-core-with-mock-provider', results }, null, 2) + '\n');
console.log(`Packaged host matrix: ${results.filter(r => r.status === 'passed').length} passed, ${results.filter(r => r.status === 'unavailable').length} unavailable, ${results.filter(r => r.status === 'failed').length} failed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
