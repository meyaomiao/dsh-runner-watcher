#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Builds a synthetic runner install on disk (no WSL, no GitHub, no network),
 * registers it as a local runner, collects it, analyses it and renders the
 * dashboard. This is what CI runs to prove the whole pipeline works.
 *
 *   node scripts/smoke.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../lib/core/analyze.js';
import { openSession } from '../lib/core/session.js';

const LISTENER = [
  '[2026-09-13 00:00:00Z INFO Listener] Version: 2.337.0',
  '[2026-09-13 02:13:31Z INFO Terminal] WRITE LINE: 2026-09-13 02:13:31Z: Running job: Verify and package',
  '[2026-09-13 02:18:31Z INFO Terminal] WRITE LINE: 2026-09-13 02:18:31Z: Job Verify and package completed with result: Succeeded',
  '[2026-09-13 02:19:11Z INFO Terminal] WRITE LINE: 2026-09-13 02:19:11Z: Running job: Deploy selected components',
  '[2026-09-13 02:20:46Z INFO Terminal] WRITE LINE: 2026-09-13 02:20:46Z: Job Deploy selected components completed with result: Failed',
].join('\n');

const WORKER = [
  "[2026-09-13 02:13:32Z INFO HostContext] Well known directory 'Root': '/runner'",
  '[2026-09-13 02:13:32Z INFO JobRunner] Job ID 23fa391a-5d37-568f-946c-4201aecbcfcb',
  '  "jobDisplayName": "Verify and package",',
  "[2026-09-13 02:13:33Z INFO StepsRunner] Processing step: DisplayName='Run actions/checkout@v5'",
  "[2026-09-13 02:13:35Z INFO StepsRunner] No need for updating job result with current step result 'Succeeded'.",
  '[2026-09-13 02:13:38Z INFO ProcessInvokerWrapper] Finished process 83699 with exit code 0, and elapsed time 00:00:03.0205632.',
  '[2026-09-13 02:18:21Z INFO JobRunner] Job result after all job steps finish: Succeeded',
  '[2026-09-13 02:18:31Z INFO Worker] Job completed.',
].join('\n');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-scope-smoke-'));
  const install = path.join(root, 'actions-runner');
  const dataDir = path.join(root, 'data');
  const diag = path.join(install, '_diag');
  await fs.mkdir(diag, { recursive: true });
  await fs.mkdir(path.join(install, '_work'), { recursive: true });
  await fs.writeFile(
    path.join(install, '.runner'),
    JSON.stringify({
      agentId: 27,
      agentName: 'smoke-runner',
      poolName: 'Default',
      gitHubUrl: 'https://github.com/acme/repo',
      workFolder: '_work',
    }),
    'utf8',
  );
  await fs.writeFile(path.join(diag, 'Runner_20260913-000000-utc.log'), LISTENER, 'utf8');
  await fs.writeFile(path.join(diag, 'Worker_20260913-021332-utc.log'), WORKER, 'utf8');

  try {
    const session = await openSession({ dataDir, settings: { windowHours: 168, rollingWindow: 6 } });

    // 1) Import by hand.
    const { runner, created } = await session.addRunner({
      transport: { kind: 'local', path: install },
    });
    assert.equal(created, true, 'runner should be newly registered');
    assert.equal(runner.identity.agentName, 'smoke-runner', '.runner should be read on import');
    assert.equal(runner.identity.agentId, 27);
    console.log('✓ import   registered', runner.label, `(${runner.id})`);

    // 2) Re-importing the same agent must not duplicate it.
    const again = await session.addRunner({ transport: { kind: 'local', path: install } });
    assert.equal(again.created, false, 're-import must update, not duplicate');
    assert.equal(session.listRunners().length, 1);
    console.log('✓ dedupe   re-import updated the same entry');

    // 3) Auto-discovery finds the install and links it to the existing entry.
    const discovery = await session.discover({ transports: ['local'], extraPaths: [install] });
    assert.ok(discovery.candidates.length >= 1, 'discovery should find the fake install');
    assert.equal(discovery.association.adopted.length, 0, 'nothing new to adopt');
    assert.equal(session.listRunners().length, 1, 'link must not duplicate');
    console.log('✓ discover found', discovery.candidates.length, 'candidate(s), linked', discovery.association.linked.length);

    // 4) Collect ingests the jobs and scores them.
    const result = await session.collect({ autoDiscover: false });
    assert.equal(result.stored.length, 2, 'both listener jobs should be stored');
    assert.equal(result.stats.completed, 2);
    assert.equal(result.stats.success, 1);
    assert.equal(result.stats.failed, 1);
    assert.ok(result.stats.rps.score > 0, 'RPS should be computed');
    assert.equal(result.stats.score_series.length, 2);
    const verified = result.stored.find((j) => j.name === 'Verify and package');
    assert.equal(verified.step_count, 1, 'worker detail should be merged in');
    assert.equal(verified.duration_sec, 300);
    console.log('✓ collect  jobs', result.stored.length, 'RPS', result.stats.rps.score, result.stats.rps.grade);

    // 5) A second collect must not duplicate the store.
    const second = await session.collect({ autoDiscover: false });
    assert.equal(second.stored.length, 2, 'repeat collect must be idempotent');
    console.log('✓ idempotent  second collect kept', second.stored.length, 'jobs');

    // 6) Analyze reads the stored history.
    const stats = await session.analyze({ hours: 168 });
    assert.equal(stats.completed, 2);
    assert.ok(stats.by_runner['smoke-runner'], 'per-runner breakdown present');
    assert.equal(stats.windowHours, 168);
    console.log('✓ analyze  rps', stats.rps.score, stats.rps.grade, 'p50', stats.duration_p50);

    // 7) Dashboard renders with the payload inlined and no leftovers.
    const html = await fs.readFile(await session.dashboard({ hours: 168 }), 'utf8');
    assert.ok(html.includes('Runner Scope'), 'title present');
    assert.ok(!html.includes('__PAYLOAD__') && !html.includes('__REFRESH_META__'), 'placeholders replaced');
    assert.ok(html.includes('smoke-runner'), 'registry render shows the runner');
    assert.ok(html.includes('已接入的 Runner'), 'registry card present');
    assert.ok(html.includes('canvas id="trend"'), 'chart present');
    console.log('✓ dashboard', (html.length / 1024).toFixed(0), 'KB');

    // 8) The analysis module is usable standalone (no session, no DSH).
    const standalone = analyze(second.stored, { windowHours: 168, rollingWindow: 6 });
    assert.equal(standalone.completed, 2);
    console.log('✓ standalone analyze works without a session');

    console.log('\nSMOKE OK');
  } finally {
    if (process.env.KEEP_SMOKE_DIR !== '1') {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.log('kept:', root);
    }
  }
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exitCode = 1;
});
