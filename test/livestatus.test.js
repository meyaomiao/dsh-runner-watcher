import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLiveStatusScript,
  parseLiveStatusOutput,
  liveStateOf,
  collectLiveStatus,
} from '../lib/core/livestatus.js';

test('buildLiveStatusScript quotes every dir and never leaks raw paths into glob context', () => {
  const s = buildLiveStatusScript(['/opt/actions-runner', "/opt/my'runner"]);
  assert.match(s, /for d in '\/opt\/actions-runner' '\/opt\/my'\\''runner'; do/);
  assert.match(s, /WorkingDirectory=\$d\$/);
  assert.match(s, /grep -F -- "\$d\/bin\/Runner\.Listener"/);
  assert.match(s, /jobDisplayName/);
  assert.match(s, /printf 'RW1\\037/);
});

const SAMPLE = [
  'RW1\u001f/opt/actions-runner\u001factions.runner.acme.R1.service\u001fActiveState=active|SubState=running|NRestarts=0|MemoryCurrent=179000000|MemoryPeak=2339000000|CPUUsageNSec=429300000000|\u001f0\u001f1\u001fvalidate',
  'RW1\u001f/opt/actions-runner-momo\u001f\u001f\u001f0\u001f0\u001f',
  'garbage line',
  '',
].join('\n');

test('parseLiveStatusOutput reads records, unit fields and tolerates noise', () => {
  const rows = parseLiveStatusOutput(SAMPLE);
  assert.equal(rows.length, 2);

  assert.equal(rows[0].path, '/opt/actions-runner');
  assert.equal(rows[0].unit, 'actions.runner.acme.R1.service');
  assert.equal(rows[0].active, 'active');
  assert.equal(rows[0].sub, 'running');
  assert.equal(rows[0].restarts, 0);
  assert.equal(rows[0].memCurrent, 179000000);
  assert.equal(rows[0].memPeak, 2339000000);
  assert.equal(rows[0].cpuSec, 429.3);
  assert.equal(rows[0].listener, false);
  assert.equal(rows[0].worker, true);
  assert.equal(rows[0].job, 'validate');

  assert.equal(rows[1].unit, null);
  assert.equal(rows[1].active, null);
  assert.equal(rows[1].listener, false);
  assert.equal(rows[1].worker, false);
  assert.equal(rows[1].job, null);

  assert.deepEqual(parseLiveStatusOutput(''), []);
});

test('liveStateOf derives the pill state from live evidence only', () => {
  assert.equal(liveStateOf({ active: 'active', worker: true }), 'busy');
  assert.equal(liveStateOf({ active: 'active', worker: false }), 'idle');
  assert.equal(liveStateOf({ active: 'inactive', worker: false }), 'offline');
  assert.equal(liveStateOf({ active: null }), 'unknown');
  assert.equal(liveStateOf(null), 'unknown');
});

test('collectLiveStatus batches one script per transport and maps rows back', async () => {
  const calls = [];
  const pool = {
    get: () => ({
      runScript: async (script) => {
        calls.push(script);
        return { code: 0, stdout: SAMPLE };
      },
    }),
  };
  const session = {
    pool,
    listRunners: () => [
      { id: 'r1', label: 'R1', enabled: true, transport: { kind: 'ssh', host: 'h', path: '/opt/actions-runner' } },
      { id: 'r2', label: 'R2', enabled: true, transport: { kind: 'ssh', host: 'h', path: '/opt/actions-runner-momo' } },
      { id: 'r3', label: 'off', enabled: false, transport: { kind: 'ssh', host: 'h', path: '/opt/disabled' } },
    ],
  };
  const out = await collectLiveStatus(session, { now: new Date('2026-09-15T02:00:00Z') });
  assert.equal(calls.length, 1, 'one batched script per transport, not per runner');
  assert.match(calls[0], /\/opt\/actions-runner/);
  assert.equal(out.ts, '2026-09-15T02:00:00.000Z');
  assert.deepEqual(out.runners.map((r) => r.id), ['r1', 'r2']);
  assert.equal(out.runners[0].state, 'busy');
  assert.deepEqual(out.errors, []);
});
