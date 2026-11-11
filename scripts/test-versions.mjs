import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const matrix = JSON.parse(await readFile(join(root, 'compatibility/releases.json'), 'utf8'));
const cordisVersions = JSON.parse(await readFile(join(root, 'compatibility/cordis-versions.json'), 'utf8'));
const wanted = process.argv.slice(2).filter(x => x !== '--all');
const selected = wanted.length ? matrix.releases.filter(r => wanted.includes(r.version)) : matrix.releases;
if (!selected.length) throw new Error('No known versions selected');
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
let previousResults = []; try { previousResults = JSON.parse(await readFile(join(root, 'compatibility/host-results.json'), 'utf8')).results; } catch {}
const results = previousResults.filter(r => !selected.some(s => s.version === r.version)); let cursor = 0;
const metadataCache = new Map();
async function packageMetadata(name, version) {
  const key = `${name}@${version}`;
  if (!metadataCache.has(key)) metadataCache.set(key, fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`).then(r => r.json()));
  return metadataCache.get(key);
}
async function run(args, cwd, timeout = 240000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', x => { output = (output + x).slice(-12000); });
    child.stderr.on('data', x => { output = (output + x).slice(-12000); });
    const timer = setTimeout(() => child.kill(), timeout);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolveResult({ code, output }); });
  });
}
await Promise.all(Array.from({ length: 3 }, async () => {
  while (cursor < selected.length) {
    const entry = selected[cursor++], version = entry.version;
    try {
      const envRoot = join(root, '.compat-cache/runtimes', version);
      await mkdir(envRoot, { recursive: true });
      const registry = 'https://registry.npmjs.org/';
      const metadata = await packageMetadata('@deepseek-ai/dsh-agent-loop', version);
      if (!metadata.version) throw new Error('Published npm host package unavailable');
      const dependencies = { '@deepseek-ai/cordis': cordisVersions.find(r => r.version === version).cordisVersion, '@deepseek-ai/dsh-agent-loop': version };
      for (const name of Object.keys(metadata.peerDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = version;
      const toolMetadata = await fetch(`${registry}@deepseek-ai%2Fdsh-tools/${version}`).then(r => r.json());
      for (const name of Object.keys(toolMetadata.peerDependencies ?? {})) if (name.startsWith('@deepseek-ai/dsh-')) dependencies[name] = version;
      const native = await fetch(`${registry}@deepseek-ai%2Fdsh-tool-executor-native/${version}`);
      if (native.ok) dependencies['@deepseek-ai/dsh-tool-executor-native'] = version;
      // Older packages used caret peer ranges. Pin the entire DSH closure to the
      // release under test instead of accidentally loading a later patch/RC.
      const visited = new Set();
      while (true) {
        const batch = Object.keys(dependencies).filter(n => n.startsWith('@deepseek-ai/dsh-') && !visited.has(n)).slice(0, 6);
        if (!batch.length) break;
        const metas = await Promise.all(batch.map(n => packageMetadata(n, version)));
        for (let i = 0; i < batch.length; i++) {
          const name = batch[i], meta = metas[i]; visited.add(name);
          if (!meta.version) throw new Error(`Required release package unavailable: ${name}@${version}`);
          for (const n of Object.keys(meta.dependencies ?? {})) if (n.startsWith('@deepseek-ai/dsh-')) dependencies[n] = version;
          for (const n of Object.keys(meta.peerDependencies ?? {})) if (n.startsWith('@deepseek-ai/dsh-') && !meta.peerDependenciesMeta?.[n]?.optional) dependencies[n] = version;
        }
      }
      const manifest = { private: true, type: 'module', dependencies };
      const manifestText = JSON.stringify(manifest, null, 2);
      let previousManifest = ''; try { previousManifest = await readFile(join(envRoot, 'package.json'), 'utf8'); } catch {}
      await writeFile(join(envRoot, 'package.json'), manifestText);
      let installed = false;
      try { const installedManifest = JSON.parse(await readFile(join(envRoot, 'node_modules/@deepseek-ai/dsh-agent-loop/package.json'), 'utf8')); installed = installedManifest.version === version; } catch {}
      if (!installed || previousManifest !== manifestText) {
        console.log(`Installing DSH ${version}`);
        const install = await run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', '--cache', join(root, '.npm-cache'), '--fetch-retries=1', '--fetch-timeout=30000'], envRoot);
        if (install.code !== 0) throw new Error(`npm install failed: ${install.output}`);
      }
      const probe = await run([join(root, 'scripts/host-probe.mjs'), envRoot, version], root, 45000);
      const match = /PROBE_RESULT (.+)/.exec(probe.output);
      if (probe.code !== 0 || !match) throw new Error(probe.output);
      results.push(JSON.parse(match[1]));
      console.log(`PASS DSH ${version}`);
    } catch (error) {
      const status = String(error).includes('Published npm host package unavailable') ? 'unavailable' : 'failed';
      results.push({ version, status, error: String(error).slice(-5000) });
      console.log(`${status.toUpperCase()} DSH ${version}: ${String(error).slice(-700)}`);
    }
    await writeFile(join(root, 'compatibility/host-results.json'), JSON.stringify({ testedAt: new Date().toISOString(), type: 'real-host-core-with-mock-provider', results }, null, 2) + '\n');
  }
}));
console.log(`Host matrix: ${results.filter(r => r.status === 'passed').length}/${matrix.releases.length} passed`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
