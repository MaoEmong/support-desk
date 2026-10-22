import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const cutoff = process.env.DEPENDENCY_CUTOFF;
if (!cutoff || !Number.isFinite(Date.parse(cutoff))) throw new Error('DEPENDENCY_CUTOFF UTC timestamp is required');
const earlierCutoff = '2026-10-20T20:23:00.025Z';
const manifests = ['package.json', 'apps/web/package.json', 'packages/contracts/package.json', 'packages/db/package.json'];
const entries = new Map();
for (const path of manifests) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (path === 'package.json' && manifest.packageManager) {
    const [name, version] = manifest.packageManager.split('@');
    entries.set(`${name}@${version}`, { name, version, owners: ['package.json:packageManager'] });
  }
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith('workspace:')) continue;
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Not exact: ${path} ${name}`);
      const key = `${name}@${version}`;
      const entry = entries.get(key) ?? { name, version, owners: [] };
      entry.owners.push(`${path}:${section}`); entries.set(key, entry);
    }
  }
}
const work = [...entries.values()]; let index = 0;
function compareVersions(a, b) {
  const av = a.split('.').map(Number); const bv = b.split('.').map(Number);
  return av[0] - bv[0] || av[1] - bv[1] || av[2] - bv[2];
}
await Promise.all(Array.from({ length: 4 }, async () => {
  while (index < work.length) {
    const entry = work[index++];
    entry.registry = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}`;
    try {
      const response = await globalThis.fetch(entry.registry, { signal: globalThis.AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
      const meta = await response.json();
      entry.publishedAt = meta.time?.[entry.version] ?? null;
      if (!entry.publishedAt) throw new Error('Registry publication timestamp missing');
      entry.eligible = Date.parse(entry.publishedAt) <= Date.parse(cutoff);
      entry.eligibleAtEarlierCutoff = Date.parse(entry.publishedAt) <= Date.parse(earlierCutoff);
      if (!entry.eligible || !entry.eligibleAtEarlierCutoff) {
        const prefix = entry.version.split('.').slice(0, 2).join('.') + '.';
        entry.latestSameMinorBeforeEarlierCutoff = Object.keys(meta.versions ?? {})
          .filter(v => /^\d+\.\d+\.\d+$/.test(v) && v.startsWith(prefix) && meta.time?.[v] && Date.parse(meta.time[v]) <= Date.parse(earlierCutoff) && !meta.versions[v].deprecated)
          .sort(compareVersions).at(-1) ?? null;
      }
    } catch (error) { entry.error = error.message; }
  }
}));
const violations = work.filter(x => x.error || !x.eligible);
const report = { cutoff, cutoffBasis: 'Installed pnpm source default minimum-release-age=1440 minutes, current-time snapshot minus 24h; parent cutoff confirmation pending', earlierObservedCutoff: earlierCutoff, manifests, exact: true, checked: work.length, violations: violations.length, results: work };
await writeFile('docs/verification/dependency-cutoff.json', JSON.stringify(report, null, 2) + '\n');
globalThis.console.log(`Exact pins checked: ${work.length}; cutoff violations or metadata errors: ${violations.length}`);
for (const row of violations) globalThis.console.log(`${row.name}@${row.version}: ${row.error ?? row.publishedAt}; same-minor earlier candidate=${row.latestSameMinorBeforeEarlierCutoff ?? 'none'}`);
if (violations.length) process.exitCode = 1;
