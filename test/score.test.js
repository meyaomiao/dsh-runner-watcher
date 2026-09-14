import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOB_WEIGHTS,
  RPS_WEIGHTS,
  composeScore,
  difficultyOf,
  rollingScoreSeries,
  runnerPerformanceScore,
  scoreJobs,
  scoreModel,
  speedScore,
} from '../lib/core/score.js';

function makeJob(overrides = {}) {
  return {
    name: 'Verify and package',
    result: 'Succeeded',
    duration_sec: 100,
    step_count: 10,
    process_elapsed_sec: 90,
    log_bytes: 200_000,
    err_count: 0,
    failed_steps: 0,
    process_nonzero_exit: 0,
    started: '2026-09-13T02:00:00Z',
    finished: '2026-09-13T02:01:40Z',
    ...overrides,
  };
}

test('composeScore renormalizes when legs are missing', () => {
  assert.equal(composeScore({ reliability: 100, speed: 50, efficiency: 50, stability: 100 }), 77.5);
  // Only reliability known -> the score IS reliability.
  assert.equal(composeScore({ reliability: 80 }), 80);
  assert.equal(composeScore({}), null);
  assert.equal(composeScore(null), null);
});

test('speedScore peaks at the median and is clamped', () => {
  assert.equal(speedScore(1), 50);
  assert.equal(speedScore(2), 90);
  assert.equal(speedScore(0.5), 10);
  // Beyond 4x the clamp keeps an outlier from running away.
  assert.equal(speedScore(64), 100);
  assert.equal(speedScore(0.001), 0);
});

test('difficultyOf grows with workload and never leaves 0..100', () => {
  const small = difficultyOf({ durationSec: 3, stepCount: 0, processSec: 0, logBytes: 1000, errCount: 0, failed: 0 });
  const large = difficultyOf({ durationSec: 600, stepCount: 40, processSec: 500, logBytes: 5e6, errCount: 5, failed: 1 });
  assert.ok(small < large);
  assert.ok(small >= 0 && large <= 100);
});

test('scoreJobs fills every leg and blends them into job_score', () => {
  const jobs = [
    makeJob({ id: 'a', duration_sec: 100 }),
    makeJob({ id: 'b', duration_sec: 100 }),
    makeJob({ id: 'c', duration_sec: 100 }),
    makeJob({ id: 'd', result: 'Failed', duration_sec: 400, err_count: 3, failed_steps: 1 }),
  ];
  scoreJobs(jobs);
  const fast = jobs[0];
  assert.equal(fast.reliability, 100);
  assert.equal(fast.speed_score, 50); // exactly the median duration
  assert.ok(fast.efficiency > 0 && fast.efficiency <= 100);
  assert.equal(fast.stability, 100);
  assert.ok(fast.job_score > 0);
  assert.match(fast.job_grade, /^[SABCDF]$/);
  assert.ok(fast.difficulty > 0);

  const failed = jobs[3];
  assert.equal(failed.reliability, 0);
  assert.ok(failed.stability < 100);
  assert.ok(failed.job_score < fast.job_score);
});

test('job_score uses the documented job weighting', () => {
  const job = makeJob();
  scoreJobs([job]);
  const expected = composeScore(
    { reliability: job.reliability, speed: job.speed_score, efficiency: job.efficiency, stability: job.stability },
    JOB_WEIGHTS,
  );
  assert.equal(job.job_score, expected);
});

test('runnerPerformanceScore aggregates a group', () => {
  const jobs = [
    makeJob({ id: 'a', result: 'Succeeded' }),
    makeJob({ id: 'b', result: 'Succeeded' }),
    makeJob({ id: 'c', result: 'Succeeded' }),
    makeJob({ id: 'd', result: 'Failed' }),
  ];
  scoreJobs(jobs);
  const rps = runnerPerformanceScore(jobs);
  assert.equal(rps.n, 4);
  assert.equal(rps.success, 3);
  assert.equal(rps.reliability, 75);
  assert.ok(rps.score > 0 && rps.score <= 100);
  assert.match(rps.grade, /^[SABCDF]$/);
});

test('runnerPerformanceScore ignores unfinished jobs', () => {
  const rps = runnerPerformanceScore([{ result: 'Running' }, { result: 'Succeeded', duration_sec: 10 }]);
  assert.equal(rps.n, 1);
});

test('rollingScoreSeries produces one point per job over a trailing window', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => makeJob({
    id: `job-${i}`,
    name: 'Task',
    result: i === 9 ? 'Failed' : 'Succeeded',
    started: `2026-09-13T02:${String(i).padStart(2, '0')}:00Z`,
    finished: `2026-09-13T02:${String(i).padStart(2, '0')}:30Z`,
    duration_sec: 30,
  }));
  scoreJobs(jobs);
  const series = rollingScoreSeries(jobs, 6);
  assert.equal(series.length, 10);
  assert.equal(series[0].n, 1);       // warm-up
  assert.equal(series[5].n, 6);       // window filled
  assert.equal(series[9].n, 6);       // slides, never grows
  assert.equal(series[9].result, 'Failed');
  assert.equal(series[9].ts, '2026-09-13T02:09:30Z');
  // The trailing failure drags the windowed reliability below 100.
  assert.ok(series[9].reliability < 100);
});

test('rollingScoreSeries orders by completion time regardless of input order', () => {
  const a = makeJob({ id: 'a', started: '2026-09-13T02:00:00Z', finished: '2026-09-13T02:01:00Z' });
  const b = makeJob({ id: 'b', started: '2026-09-13T02:05:00Z', finished: '2026-09-13T02:06:00Z' });
  scoreJobs([a, b]);
  const series = rollingScoreSeries([b, a], 6);
  assert.deepEqual(series.map((p) => p.ts), ['2026-09-13T02:01:00Z', '2026-09-13T02:06:00Z']);
});

test('scoreModel publishes the weights the renderer documents', () => {
  const model = scoreModel(6);
  assert.deepEqual(model.weights, RPS_WEIGHTS);
  assert.deepEqual(model.jobWeights, JOB_WEIGHTS);
  assert.equal(model.rollingWindow, 6);
  assert.equal(model.grades.S, 90);
});
