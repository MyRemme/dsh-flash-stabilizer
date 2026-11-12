import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const entry = `runtime-${manifest.version}`;
assert.ok((await readFile(new URL('cordis.patch.yml', root), 'utf8')).includes(`name: ./dist/${entry}.js\n`));
for (const file of await readdir(new URL('dist/', root))) {
  if (/^runtime-\d+\.\d+\.\d+\.js(?:\.map)?$/.test(file)) await unlink(new URL(`dist/${file}`, root));
}

// A release-specific entry avoids stale loader namespaces after an online update.
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/index.ts'],
  outfile: `dist/${entry}.js`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.18',
  packages: 'external',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
});
await writeFile(new URL('dist/index.js', root), `export * from './${entry}.js';\n`);
