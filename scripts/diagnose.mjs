import { readFile } from 'node:fs/promises';
const base = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', base), 'utf8'));
const matrix = JSON.parse(await readFile(new URL('compatibility/releases.json', base), 'utf8'));
const report = {
  plugin: `${pkg.name}@${pkg.version}`, node: process.version,
  auditedAt: matrix.checkedAt, auditedReleases: matrix.releases.length,
  hostTestsPassed: matrix.releases.filter(r => r.hostTest === 'passed').length,
  unavailableHostPackages: matrix.releases.filter(r => r.hostTest === 'unavailable').map(r => r.version),
  defaultMode: 'observe', availableModes: ['observe', 'assist'], automaticInterventionEnabled: false,
  note: 'Offline package check. Live plugin status is available from ctx.flashStabilizer.status(). No credentials or conversations are read.',
};
console.log(JSON.stringify(report, null, 2));
