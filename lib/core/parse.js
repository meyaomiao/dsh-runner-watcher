/**
 * Runner diagnostics parsing.
 *
 * A self-hosted runner writes two kinds of diagnostics into `<install>/_diag`:
 *
 *   Runner_<stamp>-utc.log — the listener's journal, one line per job boundary
 *   Worker_<stamp>-utc.log — one per job, with steps, processes and errors
 *
 * The listener knows *when* a job ran and *how it ended*; the worker knows
 * *what happened inside it*. A job record is the two merged. The stamp in the
 * worker filename is the worker's start time, which is what lets a listener
 * entry be matched to its worker even when the worker never logged a job name.
 *
 * @module dsh-runner-scope/core/parse
 */

import { isoOrNull, parseUtc, secondsBetween } from './util.js';

export const JOB_START_RE = /^.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})Z: Running job: (.+?)\s*$/;
export const JOB_END_RE = /^.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})Z: Job (.+) completed with result: (\w+)\s*$/;
export const WORKER_NAME_RE = /^Worker_(\d{8}-\d{6})-utc\.log$/;
export const RUNNER_NAME_RE = /^Runner_(\d{8}-\d{6})-utc\.log$/;
export const JOB_ID_RE = /Job ID ([0-9a-fA-F-]{36})/;
export const DISPLAY_NAME_RE = /"jobDisplayName":\s*"([^"]+)"/;
export const STEP_START_RE = /Processing step: DisplayName='([^']*)'/;
export const STEP_RESULT_RE = /current step result '(\w+)'/;
export const JOB_RESULT_RE = /Job result after all job steps finish: (\w+)/;
export const PROCESS_FINISH_RE = /Finished process (\d+) with exit code (-?\d+), and elapsed time (\d+):(\d+):(\d+\.\d+)/;
export const TIMESTAMP_LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})Z/;

const STEP_OK = new Set(['Succeeded', 'Success', 'Skipped', 'Cancelled', 'Canceled']);

/** `Worker_20260913-021332-utc.log` -> ISO start stamp. */
export function workerStartFromName(fileName) {
  const m = WORKER_NAME_RE.exec(String(fileName ?? ''));
  if (!m) return null;
  const raw = m[1];
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  return iso;
}

/** Extract `Running job:` / `Job ... completed with result:` pairs from a listener log. */
export function parseListenerJobs(text, { runner = null, source = null } = {}) {
  const jobs = [];
  const openByName = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const start = JOB_START_RE.exec(line);
    if (start) {
      const job = {
        runner,
        source,
        name: start[2],
        started: isoOrNull(`${start[1]}Z`),
        finished: null,
        result: 'Running',
        duration_sec: null,
        id: null,
      };
      if (!openByName.has(job.name)) openByName.set(job.name, []);
      openByName.get(job.name).push(job);
      jobs.push(job);
      continue;
    }
    const end = JOB_END_RE.exec(line);
    if (end) {
      const [, stamp, name, result] = end;
      const finished = isoOrNull(`${stamp}Z`);
      const stack = openByName.get(name);
      let target = stack?.pop();
      if (!target) {
        // An orphan completion line: keep the record rather than dropping it,
        // so a rotated listener log cannot silently lose history.
        target = { runner, source, name, started: finished, id: null };
        jobs.push(target);
      }
      target.finished = finished;
      target.result = result;
      target.duration_sec = secondsBetween(target.started, finished);
    }
  }
  return jobs;
}

/** Parse one worker log into a job detail record. */
export function parseWorkerLog(text, fileName) {
  const body = String(text ?? '');
  const startedFromName = workerStartFromName(fileName);
  let jobId = null;
  let displayName = null;
  let jobResult = null;
  let processElapsed = 0;
  let processCount = 0;
  let processNonZeroExit = 0;
  let errCount = 0;
  let firstTs = null;
  let lastTs = null;
  const steps = [];
  let pendingStep = null;

  for (const line of body.split('\n')) {
    const tsMatch = TIMESTAMP_LINE_RE.exec(line);
    const ts = tsMatch ? `${tsMatch[1]}Z` : null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (line.includes(' ERR ')) errCount += 1;
    if (jobId == null) {
      const m = JOB_ID_RE.exec(line);
      if (m) jobId = m[1];
    }
    if (displayName == null) {
      const m = DISPLAY_NAME_RE.exec(line);
      if (m) displayName = m[1];
    }
    const stepStart = STEP_START_RE.exec(line);
    if (stepStart) {
      pendingStep = { name: stepStart[1], started: ts, result: null, duration_sec: null };
      steps.push(pendingStep);
      continue;
    }
    const stepResult = STEP_RESULT_RE.exec(line);
    if (stepResult && pendingStep) {
      pendingStep.result = stepResult[1];
      pendingStep.duration_sec = secondsBetween(pendingStep.started, ts);
      pendingStep = null;
      continue;
    }
    const jobRes = JOB_RESULT_RE.exec(line);
    if (jobRes) jobResult = jobRes[1];
    const proc = PROCESS_FINISH_RE.exec(line);
    if (proc) {
      processCount += 1;
      processElapsed += Number(proc[3]) * 3600 + Number(proc[4]) * 60 + Number(proc[5]);
      if (Number(proc[2]) !== 0) processNonZeroExit += 1;
    }
  }

  const failedSteps = steps.filter((s) => s.result && !STEP_OK.has(s.result)).length;
  return {
    id: jobId,
    name: displayName,
    started: startedFromName ? isoOrNull(startedFromName) : isoOrNull(firstTs),
    finished: isoOrNull(lastTs),
    duration_sec: secondsBetween(firstTs, lastTs),
    result: jobResult,
    step_count: steps.length,
    failed_steps: failedSteps,
    steps,
    process_count: processCount,
    process_elapsed_sec: Math.round(processElapsed * 1000) / 1000,
    process_nonzero_exit: processNonZeroExit,
    log_bytes: Buffer.byteLength(body, 'utf8'),
    err_count: errCount,
  };
}

const FINAL_RESULTS = new Set([
  'Succeeded',
  'Success',
  'Failed',
  'Cancelled',
  'Canceled',
  'Skipped',
]);

const PRESERVE_IF_SET = new Set(['started', 'finished', 'duration_sec', 'name', 'runner', 'source']);

/** Merge a worker detail into a listener job, keeping the richer value per field. */
export function mergeJob(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (PRESERVE_IF_SET.has(key) && out[key] != null && out[key] !== '') continue;
    if (key === 'result' && FINAL_RESULTS.has(out.result)) continue;
    out[key] = value;
  }
  if (out.started && out.finished && out.duration_sec == null) {
    out.duration_sec = secondsBetween(out.started, out.finished);
  }
  return out;
}

/**
 * Match worker logs to listener jobs by name + start proximity.
 *
 * @param listenerJobs - from {@link parseListenerJobs}
 * @param workers - `[{ fileName, detail }]` from {@link parseWorkerLog}
 */
export function attachWorkers(listenerJobs, workers, { runner = null, source = null, toleranceSec = 12 } = {}) {
  const used = new Set();
  const out = [];
  for (const job of listenerJobs) {
    const jobStart = parseUtc(job.started);
    if (!jobStart) {
      out.push(job);
      continue;
    }
    let bestIndex = -1;
    let bestDelta = Infinity;
    for (let i = 0; i < workers.length; i += 1) {
      if (used.has(i)) continue;
      const worker = workers[i];
      if (worker.detail.name && job.name && worker.detail.name !== job.name) continue;
      const workerStart = parseUtc(worker.detail.started);
      if (!workerStart) continue;
      const delta = Math.abs((workerStart.getTime() - jobStart.getTime()) / 1000);
      if (delta <= toleranceSec && delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      used.add(bestIndex);
      out.push(mergeJob(job, workers[bestIndex].detail));
    } else {
      out.push(job);
    }
  }
  // Workers with no listener line (rotated listener log) still become jobs. The
  // worker usually knows its own outcome; only a worker that never logged one
  // is genuinely unknown.
  for (let i = 0; i < workers.length; i += 1) {
    if (used.has(i)) continue;
    const detail = workers[i].detail;
    if (!detail.name && !detail.id) continue;
    out.push({
      runner,
      source,
      ...detail,
      result: detail.result ?? 'Unknown',
      worker_log: workers[i].fileName,
    });
  }
  return out;
}

/** Relative job-start order, oldest first. */
export function compareJobStart(a, b) {
  const ta = parseUtc(a.finished ?? a.started)?.getTime() ?? 0;
  const tb = parseUtc(b.finished ?? b.started)?.getTime() ?? 0;
  return ta - tb;
}
