/**
 * The scoring model.
 *
 * Two different questions get two different numbers:
 *
 *   difficulty  — how heavy was this piece of work? (a workload index; it is
 *                 deliberately NOT part of any runner score, because a runner
 *                 is not worse for being handed harder jobs)
 *   RPS         — how well did this runner execute? (Runner Performance Score)
 *
 * RPS is a weighted blend of four 0..100 legs:
 *
 *   reliability  40%   did jobs finish successfully
 *   speed        25%   were they fast relative to the same job's history
 *   efficiency   20%   did they keep the runner busy rather than idling
 *   stability    15%   did they run clean (no errors, failed steps, exits)
 *
 * Per-job quality uses the same legs with a slightly different weighting
 * (stability matters more for a single job), and a job's RPS is the blend of
 * its own legs.
 *
 * Missing legs are dropped and the remaining weights renormalize, so a job
 * whose worker log was rotated away still scores — it just scores on less
 * evidence.
 * @module dsh-runner-watcher/core/score
 */

import { clamp, gradeOf, isSuccess, jobReliability, mean, percentile } from './util.js';

export const RPS_WEIGHTS = { reliability: 0.4, speed: 0.25, efficiency: 0.2, stability: 0.15 };
export const JOB_WEIGHTS = { reliability: 0.35, speed: 0.25, efficiency: 0.2, stability: 0.2 };
export const GRADE_BANDS = { S: 90, A: 80, B: 70, C: 60, D: 50, F: 0 };

/** The model description shipped to the dashboard and the CLI. */
export function scoreModel(rollingWindow = 6) {
  return {
    name: 'RPS',
    range: [0, 100],
    weights: { ...RPS_WEIGHTS },
    jobWeights: { ...JOB_WEIGHTS },
    grades: { ...GRADE_BANDS },
    rollingWindow,
  };
}

/**
 * Weighted blend of the four legs; `null` legs are dropped and the surviving
 * weights renormalize. Returns `null` when nothing is known.
 */
export function composeScore(legs, weights = RPS_WEIGHTS) {
  let numerator = 0;
  let denominator = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = legs?.[key];
    if (value == null || !Number.isFinite(Number(value))) continue;
    numerator += Number(value) * weight;
    denominator += weight;
  }
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10) / 10;
}

/** Aggregate the four legs over a group of jobs and blend them into one RPS. */
export function runnerPerformanceScore(items) {
  const completed = (items ?? []).filter((j) => jobReliability(j.result) != null);
  const ok = completed.filter((j) => isSuccess(j.result)).length;
  const reliability = completed.length ? Math.round((100 * ok) / completed.length * 10) / 10 : null;
  const speed = mean(completed.map((j) => j.speed_score).filter((v) => v != null));
  const efficiency = mean(completed.map((j) => j.efficiency).filter((v) => v != null));
  const stability = mean(completed.map((j) => j.stability).filter((v) => v != null));
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const score = composeScore({ reliability, speed, efficiency, stability }, RPS_WEIGHTS);
  return {
    score,
    grade: gradeOf(score),
    reliability: round(reliability),
    speed: round(speed),
    efficiency: round(efficiency),
    stability: round(stability),
    n: completed.length,
    success: ok,
    failed: completed.length - ok,
  };
}

/** Workload index (0..100). Not part of any score. */
export function difficultyOf({ durationSec, stepCount, processSec, logBytes, errCount, failed }) {
  const value =
    Math.log2(1 + (durationSec ?? 0)) * 5.2 +
    (stepCount ?? 0) * 0.9 +
    Math.log2(1 + (processSec ?? 0)) * 2.8 +
    Math.log2(1 + (logBytes ?? 0) / 1024) * 1.2 +
    (errCount ?? 0) * 0.35 +
    (failed ? 10 : 0);
  return Math.round(clamp(value) * 10) / 10;
}

/**
 * Speed leg: 50 is "exactly the median for this job name", one doubling of
 * speed adds 40 points. Clamped so an outlier cannot dominate the blend.
 */
export function speedScore(ratio) {
  return Math.round(clamp(50 + 40 * Math.log2(clamp(ratio, 0.25, 4))) * 10) / 10;
}

/**
 * Score every job in place.
 *
 * Baselines are per job name (a "Verify and package" median has nothing to say
 * about "Detect deploy targets"), falling back to the global median until a
 * name has at least three samples.
 */
export function scoreJobs(jobs) {
  const byName = new Map();
  for (const job of jobs) {
    if (job.duration_sec == null || jobReliability(job.result) == null) continue;
    const key = job.name ?? '';
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(Number(job.duration_sec));
  }
  const allDurations = [...byName.values()].flat();
  const globalMedian = percentile(allDurations, 50) ?? 60;

  for (const job of jobs) {
    const duration = Number(job.duration_sec ?? 0);
    const steps = Number(job.step_count ?? 0);
    const processSec = Number(job.process_elapsed_sec ?? 0);
    const logBytes = Number(job.log_bytes ?? 0);
    const errCount = Number(job.err_count ?? 0);
    const failedSteps = Number(job.failed_steps ?? 0);
    const nonZero = Number(job.process_nonzero_exit ?? 0);
    const reliability = jobReliability(job.result);
    const failed = reliability === 0 ? 1 : 0;

    job.difficulty = difficultyOf({
      durationSec: duration,
      stepCount: steps,
      processSec,
      logBytes,
      errCount,
      failed,
    });

    const busy = duration > 0 ? clamp(processSec / duration, 0, 1.5) : 0;
    job.busy_ratio = Math.round(busy * 1000) / 1000;

    const samples = byName.get(job.name ?? '') ?? [];
    const median = (samples.length >= 3 ? percentile(samples, 50) : globalMedian) || globalMedian;
    job.median_duration_sec = Math.round(median * 1000) / 1000;
    job.reliability = reliability;

    if (duration > 0 && median > 0) {
      const ratio = median / duration;
      job.speed_index = Math.round(clamp(100 * ratio, 0, 300) * 10) / 10;
      job.speed_score = speedScore(ratio);
    } else {
      job.speed_index = null;
      job.speed_score = null;
    }

    let efficiency = (busy / 1.5) * 40;
    if (duration > 0 && median > 0) efficiency += Math.min(40, (40 * median) / duration);
    if (reliability === 100) efficiency += 20;
    job.efficiency = Math.round(clamp(efficiency) * 10) / 10;

    let penalty = errCount * 6 + failedSteps * 10 + nonZero * 4;
    if (failed) penalty += 15;
    job.stability = Math.round(clamp(100 - penalty) * 10) / 10;

    job.job_score = composeScore(
      {
        reliability,
        speed: job.speed_score,
        efficiency: job.efficiency,
        stability: job.stability,
      },
      JOB_WEIGHTS,
    );
    job.job_grade = gradeOf(job.job_score);
  }
  return jobs;
}

/**
 * One RPS point per completed job, each computed over the trailing `window`
 * jobs. This is what the trend chart plots: a moving view of runner quality
 * rather than three unrelated lines.
 */
export function rollingScoreSeries(jobs, window = 6) {
  const ordered = (jobs ?? [])
    .filter((j) => jobReliability(j.result) != null)
    .sort((a, b) => {
      const ta = Date.parse(a.finished ?? a.started ?? 0) || 0;
      const tb = Date.parse(b.finished ?? b.started ?? 0) || 0;
      return ta - tb;
    });
  return ordered.map((job, index) => {
    const chunk = ordered.slice(Math.max(0, index - window + 1), index + 1);
    const rps = runnerPerformanceScore(chunk);
    return {
      ts: job.finished ?? job.started,
      score: rps.score,
      grade: rps.grade,
      n: rps.n,
      reliability: rps.reliability,
      speed: rps.speed,
      efficiency: rps.efficiency,
      stability: rps.stability,
      job: job.name,
      job_score: job.job_score ?? null,
      result: job.result,
      duration_sec: job.duration_sec ?? null,
      runner: job.runner ?? null,
      window,
    };
  });
}
