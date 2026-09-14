import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachWorkers,
  mergeJob,
  parseListenerJobs,
  parseWorkerLog,
  workerStartFromName,
} from '../lib/core/parse.js';

const LISTENER_LOG = [
  '[2026-09-13 02:13:31Z INFO Terminal] WRITE LINE: 2026-09-13 02:13:31Z: Running job: Verify and package',
  '[2026-09-13 02:18:31Z INFO Terminal] WRITE LINE: 2026-09-13 02:18:31Z: Job Verify and package completed with result: Succeeded',
  '[2026-09-13 02:19:11Z INFO Terminal] WRITE LINE: 2026-09-13 02:19:11Z: Running job: Deploy selected components',
  '[2026-09-13 02:20:46Z INFO Terminal] WRITE LINE: 2026-09-13 02:20:46Z: Job Deploy selected components completed with result: Failed',
].join('\n');

const WORKER_LOG = [
  '[2026-09-13 02:13:32Z INFO HostContext] Well known directory \'Root\': \'/opt/actions-runner\'',
  '[2026-09-13 02:13:32Z INFO JobRunner] Job ID 23fa391a-5d37-568f-946c-4201aecbcfcb',
  '  "jobDisplayName": "Verify and package",',
  '[2026-09-13 02:13:33Z INFO StepsRunner] Processing step: DisplayName=\'Run actions/checkout@v5\'',
  '[2026-09-13 02:13:35Z INFO StepsRunner] No need for updating job result with current step result \'Succeeded\'.',
  '[2026-09-13 02:13:35Z INFO StepsRunner] Processing step: DisplayName=\'Skipped step\'',
  '[2026-09-13 02:13:35Z INFO StepsRunner] No need for updating job result with current step result \'Skipped\'.',
  '[2026-09-13 02:13:36Z INFO StepsRunner] Processing step: DisplayName=\'Broken step\'',
  '[2026-09-13 02:13:37Z INFO StepsRunner] No need for updating job result with current step result \'Failed\'.',
  '[2026-09-13 02:13:38Z INFO ProcessInvokerWrapper] Finished process 83699 with exit code 0, and elapsed time 00:00:03.0205632.',
  '[2026-09-13 02:13:39Z INFO ProcessInvokerWrapper] Finished process 83700 with exit code 2, and elapsed time 00:00:01.5000000.',
  '[2026-09-13 02:13:40Z ERR  BrokerServer] something broke',
  '[2026-09-13 02:18:21Z INFO JobRunner] Job result after all job steps finish: Succeeded',
  '[2026-09-13 02:18:31Z INFO Worker] Job completed.',
].join('\n');

test('workerStartFromName parses the worker filename stamp', () => {
  assert.equal(workerStartFromName('Worker_20260913-021332-utc.log'), '2026-09-13T02:13:32Z');
  assert.equal(workerStartFromName('Runner_20260913-021332-utc.log'), null);
});

test('parseListenerJobs pairs starts with completions', () => {
  const jobs = parseListenerJobs(LISTENER_LOG, { runner: 'r1', source: 'wsl:Ubuntu' });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, 'Verify and package');
  assert.equal(jobs[0].result, 'Succeeded');
  assert.equal(jobs[0].duration_sec, 300);
  assert.equal(jobs[1].result, 'Failed');
  assert.equal(jobs[1].duration_sec, 95);
  assert.equal(jobs[0].runner, 'r1');
});

test('parseListenerJobs keeps an orphan completion instead of dropping it', () => {
  const jobs = parseListenerJobs('2026-09-13 02:18:31Z: Job Ghost completed with result: Failed\n');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'Ghost');
  assert.equal(jobs[0].result, 'Failed');
});

test('parseWorkerLog captures steps, processes and error lines', () => {
  const detail = parseWorkerLog(WORKER_LOG, 'Worker_20260913-021332-utc.log');
  assert.equal(detail.id, '23fa391a-5d37-568f-946c-4201aecbcfcb');
  assert.equal(detail.name, 'Verify and package');
  assert.equal(detail.result, 'Succeeded');
  assert.equal(detail.step_count, 3);
  // Skipped must not count as a failed step.
  assert.equal(detail.failed_steps, 1);
  assert.equal(detail.process_count, 2);
  assert.equal(detail.process_nonzero_exit, 1);
  assert.equal(detail.err_count, 1);
  assert.equal(detail.process_elapsed_sec, 4.521);
  assert.equal(detail.started, '2026-09-13T02:13:32Z');
  assert.equal(detail.finished, '2026-09-13T02:18:31Z');
});

test('attachWorkers merges a worker into its listener job by name and time', () => {
  const listenerJobs = parseListenerJobs(LISTENER_LOG, { runner: 'r1' });
  const workers = [{ fileName: 'Worker_20260913-021332-utc.log', detail: parseWorkerLog(WORKER_LOG, 'Worker_20260913-021332-utc.log') }];
  const jobs = attachWorkers(listenerJobs, workers, { runner: 'r1', source: 'wsl:Ubuntu' });
  const merged = jobs.find((j) => j.name === 'Verify and package');
  assert.equal(merged.step_count, 3);
  assert.equal(merged.err_count, 1);
  assert.equal(merged.result, 'Succeeded');
  // The unmatched listener job survives without worker detail.
  const other = jobs.find((j) => j.name === 'Deploy selected components');
  assert.equal(other.result, 'Failed');
  assert.equal(other.step_count, undefined);
});

test('attachWorkers keeps a worker whose listener line was rotated away', () => {
  const workers = [{ fileName: 'Worker_20260913-021332-utc.log', detail: parseWorkerLog(WORKER_LOG, 'Worker_20260913-021332-utc.log') }];
  const jobs = attachWorkers([], workers, { runner: 'r1', source: 'wsl:Ubuntu' });
  assert.equal(jobs.length, 1);
  // The worker logged its own outcome, so the job is not "Unknown".
  assert.equal(jobs[0].result, 'Succeeded');
  assert.equal(jobs[0].runner, 'r1');
  assert.equal(jobs[0].step_count, 3);
});

test('attachWorkers reports Unknown only when the worker logged no outcome', () => {
  const orphanWorker = [
    '[2026-09-13 02:13:32Z INFO JobRunner] Job ID 11111111-2222-3333-4444-555555555555',
    '  "jobDisplayName": "Interrupted job",',
    '[2026-09-13 02:13:35Z INFO StepsRunner] Processing step: DisplayName=\'Run\'',
  ].join('\n');
  const jobs = attachWorkers([], [{ fileName: 'Worker_20260913-021332-utc.log', detail: parseWorkerLog(orphanWorker, 'Worker_20260913-021332-utc.log') }], {
    runner: 'r1',
    source: 'wsl:Ubuntu',
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].result, 'Unknown');
});

test('attachWorkers does not steal a worker from a different job name', () => {
  const listenerJobs = parseListenerJobs(
    '2026-09-13 02:13:31Z: Running job: Other job\n2026-09-13 02:14:00Z: Job Other job completed with result: Succeeded\n',
  );
  const workers = [{ fileName: 'Worker_20260913-021332-utc.log', detail: parseWorkerLog(WORKER_LOG, 'Worker_20260913-021332-utc.log') }];
  const jobs = attachWorkers(listenerJobs, workers, { runner: 'r1' });
  // The name mismatch leaves both records intact rather than cross-linking them.
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((j) => j.name === 'Other job').step_count, undefined);
});

test('mergeJob prefers final results and richer fields', () => {
  const merged = mergeJob(
    { name: 'x', started: '2026-09-13T02:13:31Z', finished: null, result: 'Running', duration_sec: null },
    { finished: '2026-09-13T02:18:31Z', result: 'Succeeded', step_count: 5 },
  );
  assert.equal(merged.result, 'Succeeded');
  assert.equal(merged.finished, '2026-09-13T02:18:31Z');
  assert.equal(merged.duration_sec, 300);
  assert.equal(merged.step_count, 5);

  // A later Failed must not overwrite a settled Succeeded.
  const kept = mergeJob({ result: 'Succeeded' }, { result: 'Failed' });
  assert.equal(kept.result, 'Succeeded');
});
