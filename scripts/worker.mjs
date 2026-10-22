import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import { projectRoot, loadRootEnvironment, runtimeIdentity, launchPnpm, supervise } from './processes.mjs';
import console from 'node:console';

loadRootEnvironment();
console.info('worker.runtime', JSON.stringify(runtimeIdentity()));
const bootstrap = process.env.WORKER_BOOTSTRAP_MODULE ?? pathToFileURL(join(projectRoot, 'apps/web/src/server/ai/worker-bootstrap.ts')).href;
await supervise([launchPnpm(['--filter', '@support/queue', 'worker'], { WORKER_BOOTSTRAP_MODULE: bootstrap })]);
