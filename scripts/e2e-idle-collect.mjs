/**
 * E2E: does a busy -> idle jump actually trigger a collection?
 *
 * Synthetic runner on a REAL transport (local), real live script, real timer:
 * a fake Runner.Listener keeps it "idle", a fake Runner.Worker makes it "busy",
 * killing the worker is the job-finished signal the feature listens for.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { apply, DASHBOARD_PATH } from '../lib/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-e2e-'));
const dataDir = path.join(root, 'data');
const install = path.join(root, 'fake-runner');
await fs.mkdir(path.join(install, '_diag'), { recursive: true });
await fs.mkdir(path.join(install, 'bin'), { recursive: true });
await fs.writeFile(
  path.join(install, '.runner'),
  JSON.stringify({ agentId: 999, agentName: 'fake-runner', gitHubUrl: 'https://github.com/acme/fake' }),
  'utf8',
);
await fs.symlink('/bin/sleep', path.join(install, 'bin', 'Runner.Listener'));
await fs.symlink('/bin/sleep', path.join(install, 'bin', 'Runner.Worker'));

const tools = new Map();
const routes = [];
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
  logger: { info() {} },
  inject(names, cb) {
    if (names[0] !== 'webServer') return;
    cb({
      effect: (f) => f?.(),
      webServer: { register: (r) => { routes.push(r); return () => {}; } },
    });
  },
};

apply(ctx, {
  dataDir,
  liveIntervalSec: 2,
  autoCollectOnIdle: true,
  autoCollectCooldownSec: 0,
  autoDiscover: false,
});

await tools.get('runner_watcher_add').execute({ kind: 'local', path: install }, {});

const handler = routes[0].handler;
const call = (suffix) =>
  new Promise((resolve, reject) => {
    const res = { c: 0, b: '', writeHead(c) { this.c = c; }, end(b) { this.b = b; resolve(this); } };
    Promise.resolve(handler({ url: `${DASHBOARD_PATH}${suffix}`, method: 'GET' }, res)).catch(reject);
  });
const snapshot = async () => {
  const res = await call('/api/live');
  const body = JSON.parse(res.b);
  const row = (body.runners || []).find((r) => r.label === 'fake-runner') ?? null;
  return { state: row?.state ?? null, worker: row?.worker ?? null, auto: body.autoCollect };
};

const listener = spawn(path.join(install, 'bin', 'Runner.Listener'), ['300'], { stdio: 'ignore' });
await sleep(4500);
const idleSnapshot = await snapshot();

const worker = spawn(path.join(install, 'bin', 'Runner.Worker'), ['300'], { stdio: 'ignore' });
await sleep(4500);
const busySnapshot = await snapshot();

worker.kill('SIGKILL');
await sleep(6000);
const afterSnapshot = await snapshot();

const storeFiles = await fs.readdir(dataDir);
const state = JSON.parse(await fs.readFile(path.join(dataDir, 'last_state.json'), 'utf8'));

console.log('phase           state    worker  autoCollect.count  lastAt');
console.log('baseline(list)  ' + String(idleSnapshot.state).padEnd(8) + String(idleSnapshot.worker).padEnd(8) + String(idleSnapshot.auto.count).padEnd(19) + (idleSnapshot.auto.lastAt ?? '-'));
console.log('worker up       ' + String(busySnapshot.state).padEnd(8) + String(busySnapshot.worker).padEnd(8) + String(busySnapshot.auto.count).padEnd(19) + (busySnapshot.auto.lastAt ?? '-'));
console.log('worker killed   ' + String(afterSnapshot.state).padEnd(8) + String(afterSnapshot.worker).padEnd(8) + String(afterSnapshot.auto.count).padEnd(19) + (afterSnapshot.auto.lastAt ?? '-'));
console.log('\nstore files:', storeFiles.join(', '));
console.log('last_state runner state:', state.runners?.[0]?.state, '· collected:', state.collected);

const ok =
  idleSnapshot.state === 'idle' &&
  busySnapshot.state === 'busy' &&
  afterSnapshot.state === 'idle' &&
  afterSnapshot.auto.count > busySnapshot.auto.count &&
  storeFiles.includes('last_state.json') &&
  storeFiles.includes('jobs.jsonl');
console.log('\nE2E:', ok ? 'PASS' : 'FAIL');

listener.kill('SIGKILL');
await fs.rm(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
