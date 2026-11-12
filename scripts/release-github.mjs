import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { list } from 'tar';
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const notes = (await readFile(new URL(`../releases/${pkg.version}.zh-CN.md`, import.meta.url), 'utf8')).trim();
assert.ok(notes.startsWith(`# DSH Flash Stabilizer ${pkg.version} - `), 'Write version-specific Chinese release notes before publishing');
const title = notes.split('\n', 1)[0].slice(2);
const tag = `v${pkg.version}`, archive = resolve(`artifacts/${pkg.name}-${pkg.version}.tgz`);
const data = await readFile(archive);
const entries = new Map();
await list({ file: archive, strict: true, onReadEntry: entry => {
  if (!entry.path.startsWith('package/node_modules/') && entry.type === 'File') {
    const chunks = []; entry.on('data', part => chunks.push(part)); entry.on('end', () => entries.set(entry.path.slice(8), Buffer.concat(chunks)));
  }
} });
assert.equal(JSON.parse(entries.get('package.json').toString()).version, pkg.version);
for (const [file, bytes] of entries) assert.deepEqual(await readFile(resolve(file)), bytes, `Repack the reviewed ${file} before publishing`);
assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), 'Only formal versions can be released');
const sha256 = createHash('sha256').update(data).digest('hex');
const sums = Buffer.from(`${sha256}  ${pkg.name}-${pkg.version}.tgz\n`);
await writeFile(resolve('artifacts/checksums.sha256'), sums);
const { githubCredential } = await import('../dist/updater.js');
const token = await githubCredential(); assert.ok(token, 'GitHub credential unavailable');
const base = 'https://api.github.com/repos/MyRemme/dsh-flash-stabilizer';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': pkg.name, 'X-GitHub-Api-Version': '2022-11-28' };
async function request(url, options = {}) {
  const result = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert.ok(result.ok, `GitHub request failed: HTTP ${result.status}`);
  return result.json();
}
const repository = await request(base); // Preserve the repository's current visibility.
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim(), '', 'Commit all reviewed changes before release');
const branch = await request(`${base}/commits/main`); assert.equal(branch.sha, head, 'Push the reviewed commit first');
const exists = await fetch(`${base}/releases/tags/${tag}`, { headers, signal: AbortSignal.timeout(15000) });
assert.equal(exists.status, 404, 'Refuse overwriting an existing release');
const release = await request(`${base}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
  tag_name: tag, target_commitish: head, name: title, draft: true, prerelease: false,
  body: `${notes}\n\n## 安装包校验\n\nSHA-256（${pkg.name}-${pkg.version}.tgz）：\n\n\`\`\`text\n${sha256}\n\`\`\`\n`,
}) });
const upload = release.upload_url.replace(/\{.*$/, '');
for (const [name, bytes, type] of [[`${pkg.name}-${pkg.version}.tgz`, data, 'application/gzip'], ['checksums.sha256', sums, 'text/plain']]) {
  await request(`${upload}?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
}
const published = await request(`${base}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) });
console.log(JSON.stringify({ published: true, private: repository.private, version: pkg.version, url: published.html_url, sha256 }));
