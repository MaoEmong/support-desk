import process from 'node:process';
import { loadRootEnvironment, runtimeIdentity, launchPnpm, supervise } from './processes.mjs';
import console from 'node:console';

loadRootEnvironment();
console.info('dev.runtime', JSON.stringify(runtimeIdentity()));
const web = launchPnpm(['--filter', '@support/web', 'dev', ...process.argv.slice(2)]);
const worker = launchPnpm(['worker']);
await supervise([web, worker]);
