import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const envPath = join(root, '.env');
const marker = randomUUID();
const content = `SUPPORT_DESK_CWD_PROBE=${marker}\n`;
// Never overwrite an existing environment file or print its contents.
await writeFile(envPath, content, { flag: 'wx' });
try {
  const moduleUrl = new URL('../src/index.ts', import.meta.url).href;
  const loaderUrl = pathToFileURL(createRequire(new URL('../package.json', import.meta.url)).resolve('tsx/esm')).href;
  for (const relative of ['.', 'packages/db', 'apps/web']) {
    const code = `const mod = await import(${JSON.stringify(moduleUrl)}); const ok = process.env.SUPPORT_DESK_CWD_PROBE === ${JSON.stringify(marker)}; await mod.pool.end(); if (!ok) process.exit(1);`;
    const childEnv = { ...process.env };
    delete childEnv.SUPPORT_DESK_CWD_PROBE;
    const child = spawnSync(process.execPath, ['--import', loaderUrl, '--input-type=module', '-e', code], { cwd: resolve(root, relative), env: childEnv, encoding: 'utf8' });
    assert.equal(child.status, 0, `${relative}: probe child failed (child output withheld)`);
    globalThis.console.log(`${relative}: root .env loaded; pool closed`);
  }
} finally {
  assert.equal(await readFile(envPath, 'utf8'), content, 'Probe .env changed; refusing to remove it');
  await unlink(envPath);
}
