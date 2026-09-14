import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../lib/core/analyze.js';
import {
  currentJobFromListener,
  parseCounter,
  parsePsLine,
  parseSystemdShow,
} from '../lib/core/collect.js';
import { filterWindow, jobKey, loadJobs, upsertJobs } from '../lib/core/store.js';
import { scoreJobs } from '../lib/core/score.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-scope-store-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const job = (overrides = {}) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  runner: 'r1',
  name: 'Task',
  result: 'Succeeded',
  started: '2026-09-13T02:00:00Z',
  finished: '2026-09-13T02:01:00Z',
  duration_sec: 60,
  step_count: 3,
  process_elapsed_sec: 50,
  log_bytes: 10_000,
  err_count: 0,
  failed_steps: 0,
  process_nonzero_exit: 0,
  ...overrides,
});

test('jobKey prefers the runner job id', () => {
  assert.equal(jobKey({ id: 'x' }), 'id:x');
  assert.equal(jobKey({ runner: 'r', name: 'n', started: 's' }), 'r|n|s');
});

test('upsertJobs dedupes by id and keeps the richer record', async () => {
  await withTempDir(async (dir) => {
    await upsertJobs(dir, [job()]);
    let stored = await loadJobs(dir);
    assert.equal(stored.length, 1);
    assert.ok(stored[0].job_score != null);

    // Same job, now with the worker detail that arrived later.
    await upsertJobs(dir, [job({ step_count: 9, err_count: 2 })]);
    stored = await loadJobs(dir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].step_count, 9);

    // A genuinely different job is appended.
    await upsertJobs(dir, [job({ id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' })]);
    stored = await loadJobs(dir);
    assert.equal(stored.length, 2);
  });
});

test('upsertJobs scores every stored row, newest first', async () => {
  await withTempDir(async (dir) => {
    await upsertJobs(dir, [
      job({ id: 'old', started: '2026-09-12T02:00:00Z', finished: '2026-09-12T02:01:00Z' }),
      job({ id: 'new', started: '2026-09-13T02:00:00Z', finished: '2026-09-13T02:01:00Z' }),
    ]);
    const stored = await loadJobs(dir);
    assert.deepEqual(stored.map((j) => j.id), ['new', 'old']);
    for (const row of stored) {
      assert.ok(row.job_score != null);
      assert.ok(row.difficulty != null);
    }
  });
});

test('loadJobs tolerates a missing or torn store', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadJobs(dir), []);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'jobs.jsonl'), `${JSON.stringify(job())}\n{"torn":`, 'utf8');
    const stored = await loadJobs(dir);
    assert.equal(stored.length, 1);
  });
});

test('filterWindow keeps only jobs inside the window', () => {
  const now = Date.parse('2026-09-14T00:00:00Z');
  const jobs = [
    job({ id: 'in', finished: '2026-09-13T20:00:00Z' }),
    job({ id: 'out', finished: '2026-09-01T00:00:00Z' }),
  ];
  assert.deepEqual(filterWindow(jobs, 24, now).map((j) => j.id), ['in']);
  assert.equal(filterWindow(jobs, 0, now).length, 2);
});

test('analyze aggregates runners, job names and the RPS series', () => {
  const jobs = [
    job({ id: 'a', runner: 'r1', name: 'Build', started: '2026-09-13T02:00:00Z', finished: '2026-09-13T02:01:00Z' }),
    job({ id: 'b', runner: 'r1', name: 'Build', result: 'Failed', started: '2026-09-13T03:00:00Z', finished: '2026-09-13T03:02:00Z', duration_sec: 120 }),
    job({ id: 'c', runner: 'r2', name: 'Deploy', started: '2026-09-13T04:00:00Z', finished: '2026-09-13T04:00:30Z', duration_sec: 30 }),
    job({ id: 'd', runner: 'r2', name: 'Deploy', result: 'Running', finished: null, duration_sec: null }),
  ];
  scoreJobs(jobs);
  const stats = analyze(jobs, { windowHours: 168, rollingWindow: 6 });
  assert.equal(stats.window_jobs, 4);
  assert.equal(stats.completed, 3);
  assert.equal(stats.running, 1);
  assert.equal(stats.success, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.by_runner.r1.count, 2);
  assert.equal(stats.by_runner.r2.count, 1);
  assert.equal(stats.by_job_name[0].name, 'Build');
  assert.equal(stats.score_series.length, 3);
  assert.ok(stats.score_by_runner.r1.length === 2);
  assert.equal(stats.score_model.rollingWindow, 6);
  assert.ok(stats.weakest.length >= 1);
  assert.equal(stats.weakest[0].id, 'b');
});

test('parseSystemdShow reads key=value pairs', () => {
  const show = parseSystemdShow('ActiveState=active\nMemoryCurrent=189693952\nResult=success\n');
  assert.equal(show.ActiveState, 'active');
  assert.equal(show.MemoryCurrent, '189693952');
  assert.equal(show.missing, undefined);
});

test('parseCounter rejects systemd sentinels and keeps real values', () => {
  assert.equal(parseCounter('189693952'), 189693952);
  assert.equal(parseCounter('[not set]'), 0);
  assert.equal(parseCounter('18446744073709551615'), 0); // unset unsigned sentinel
  assert.equal(parseCounter(''), 0);
  assert.equal(parseCounter(undefined), 0);
  assert.equal(parseCounter('-1'), 0);
});

test('parsePsLine reads a ps row without splitting the command', () => {
  const row = parsePsLine('  281 03:21:18  0.0  0.8 144504 274304772 /opt/actions-runner/bin/Runner.Listener run --startuptype service');
  assert.equal(row.pid, 281);
  assert.equal(row.rss_kb, 144504);
  assert.equal(row.cmd, '/opt/actions-runner/bin/Runner.Listener run --startuptype service');
  assert.equal(parsePsLine('garbage'), null);
});

test('currentJobFromListener returns only an unfinished job', () => {
  const running = [
    '2026-09-13 02:13:31Z: Running job: Verify and package',
  ].join('\n');
  assert.equal(currentJobFromListener(running).name, 'Verify and package');

  const finished = [
    '2026-09-13 02:13:31Z: Running job: Verify and package',
    '2026-09-13 02:18:31Z: Job Verify and package completed with result: Succeeded',
  ].join('\n');
  assert.equal(currentJobFromListener(finished), null);
});
