/**
 * Aggregation over stored jobs: what the CLI prints and the dashboard plots.
 * @module dsh-runner-scope/core/analyze
 */

import { isSuccess, jobReliability, mean, percentile } from './util.js';
import { rollingScoreSeries, runnerPerformanceScore, scoreModel } from './score.js';

const BRIEF_KEYS = [
  'id',
  'runner',
  'name',
  'started',
  'finished',
  'duration_sec',
  'result',
  'step_count',
  'difficulty',
  'efficiency',
  'speed_index',
  'speed_score',
  'stability',
  'reliability',
  'job_score',
  'job_grade',
  'err_count',
  'busy_ratio',
];

export function briefJobs(jobs) {
  return jobs.map((job) => {
    const out = {};
    for (const key of BRIEF_KEYS) out[key] = job[key] ?? null;
    return out;
  });
}

function packGroup(items) {
  const durations = items.map((j) => Number(j.duration_sec)).filter(Number.isFinite);
  const success = items.filter((j) => isSuccess(j.result)).length;
  const rps = runnerPerformanceScore(items);
  const jobScores = items.map((j) => j.job_score).filter((v) => v != null);
  const speedIndexes = items.map((j) => j.speed_index).filter((v) => v != null);
  return {
    count: items.length,
    success,
    failed: items.length - success,
    success_rate: items.length ? Math.round((success / items.length) * 1000) / 1000 : 0,
    duration_p50: Math.round((percentile(durations, 50) ?? 0) * 100) / 100,
    duration_p95: Math.round((percentile(durations, 95) ?? 0) * 100) / 100,
    difficulty_avg: mean(items.map((j) => j.difficulty ?? 0)) ?? 0,
    efficiency_avg: rps.efficiency ?? 0,
    speed_avg: Math.round((mean(speedIndexes) ?? 0) * 10) / 10,
    job_score_avg: mean(jobScores),
    rps: rps.score,
    grade: rps.grade,
    reliability: rps.reliability,
    speed_score: rps.speed,
    stability: rps.stability,
  };
}

/**
 * Full analysis of one job window.
 * @param jobs - already scored (see `scoreJobs`)
 * @param options.windowHours - reported back for context
 * @param options.rollingWindow - RPS rolling window
 */
export function analyze(jobs, { windowHours = 168, rollingWindow = 6 } = {}) {
  const completed = jobs.filter((job) => jobReliability(job.result) != null);
  const succeeded = completed.filter((job) => isSuccess(job.result));
  const failed = completed.length - succeeded.length;
  const durations = completed.map((j) => Number(j.duration_sec)).filter(Number.isFinite);
  const difficulties = completed.map((j) => j.difficulty).filter((v) => v != null);
  const jobScores = completed.map((j) => j.job_score).filter((v) => v != null);
  const speedIndexes = completed.map((j) => j.speed_index).filter((v) => v != null);

  const byRunner = new Map();
  const byName = new Map();
  const byHour = new Map();
  for (const job of completed) {
    const runner = job.runner ?? '?';
    const name = job.name ?? '?';
    const hour = `${String(job.started ?? '').slice(0, 13)}:00:00Z`;
    if (!byRunner.has(runner)) byRunner.set(runner, []);
    if (!byName.has(name)) byName.set(name, []);
    if (!byHour.has(hour)) byHour.set(hour, []);
    byRunner.get(runner).push(job);
    byName.get(name).push(job);
    byHour.get(hour).push(job);
  }

  const runnerStats = {};
  for (const [name, items] of [...byRunner].sort(([a], [b]) => a.localeCompare(b))) {
    runnerStats[name] = packGroup(items);
  }

  const nameStats = [...byName.entries()]
    .map(([name, items]) => ({ name, ...packGroup(items) }))
    .sort((a, b) => b.count - a.count);

  const hourly = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, items]) => ({ hour, ...packGroup(items) }));

  const scoreSeries = rollingScoreSeries(completed, rollingWindow);
  const scoreByRunner = {};
  for (const [name, items] of [...byRunner].sort(([a], [b]) => a.localeCompare(b))) {
    scoreByRunner[name] = rollingScoreSeries(items, Math.max(2, rollingWindow - 1));
  }

  const byDesc = (key) => (a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
  const byAsc = (key) => (a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity);
  const withKey = (key) => completed.filter((j) => j[key] != null);

  const overall = runnerPerformanceScore(completed);
  return {
    windowHours,
    window_jobs: jobs.length,
    completed: completed.length,
    running: jobs.filter((j) => j.result === 'Running').length,
    success: succeeded.length,
    failed,
    success_rate: completed.length ? Math.round((succeeded.length / completed.length) * 1000) / 1000 : 0,
    duration_p50: Math.round((percentile(durations, 50) ?? 0) * 100) / 100,
    duration_p95: Math.round((percentile(durations, 95) ?? 0) * 100) / 100,
    duration_max: durations.length ? Math.round(Math.max(...durations) * 100) / 100 : 0,
    difficulty_avg: Math.round((mean(difficulties) ?? 0) * 10) / 10,
    efficiency_avg: overall.efficiency ?? 0,
    speed_avg: Math.round((mean(speedIndexes) ?? 0) * 10) / 10,
    job_score_avg: Math.round((mean(jobScores) ?? 0) * 10) / 10,
    rps: overall,
    score_model: scoreModel(rollingWindow),
    by_runner: runnerStats,
    by_job_name: nameStats,
    hourly,
    score_series: scoreSeries,
    score_by_runner: scoreByRunner,
    slowest: briefJobs([...withKey('duration_sec')].sort(byDesc('duration_sec')).slice(0, 8)),
    hardest: briefJobs([...withKey('difficulty')].sort(byDesc('difficulty')).slice(0, 8)),
    least_efficient: briefJobs([...withKey('efficiency')].sort(byAsc('efficiency')).slice(0, 8)),
    weakest: briefJobs([...withKey('job_score')].sort(byAsc('job_score')).slice(0, 8)),
  };
}
