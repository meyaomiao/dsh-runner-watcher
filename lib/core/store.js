/**
 * JSONL job store.
 *
 * Jobs are keyed so that repeated `collect` runs update a job in place instead
 * of appending duplicates: the runner's own `Job ID` when the worker log was
 * seen, otherwise `runner | name | started`. The store is append-only for
 * snapshots (a pure time series) and rewrite-in-place for jobs (a keyed set).
 * @module dsh-runner-scope/core/store
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { mergeJob } from './parse.js';
import { scoreJobs } from './score.js';

export function jobsPath(dataDir) {
  return path.join(dataDir, 'jobs.jsonl');
}

export function snapshotsPath(dataDir) {
  return path.join(dataDir, 'snapshots.jsonl');
}

export function jobKey(job) {
  if (job?.id) return `id:${job.id}`;
  return `${job?.runner ?? ''}|${job?.name ?? ''}|${job?.started ?? ''}`;
}

export async function loadJsonl(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A torn last line from a concurrent writer is expected; skip it.
    }
  }
  return rows;
}

export async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  await fs.writeFile(tmp, body ? `${body}\n` : '', 'utf8');
  await fs.rename(tmp, file);
}

export async function appendJsonl(file, row) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Merge incoming jobs into the store, re-score everything, newest first.
 * @returns the full stored set
 */
export async function upsertJobs(dataDir, incoming) {
  const file = jobsPath(dataDir);
  const existing = await loadJsonl(file);
  const byKey = new Map(existing.map((job) => [jobKey(job), job]));
  for (const job of incoming) {
    const key = jobKey(job);
    byKey.set(key, byKey.has(key) ? mergeJob(byKey.get(key), job) : job);
  }
  const rows = [...byKey.values()].sort((a, b) =>
    String(b.started ?? '').localeCompare(String(a.started ?? '')),
  );
  scoreJobs(rows);
  await writeJsonl(file, rows);
  return rows;
}

/** Load stored jobs, re-scoring them so a model change applies retroactively. */
export async function loadJobs(dataDir) {
  const rows = await loadJsonl(jobsPath(dataDir));
  scoreJobs(rows);
  return rows;
}

/** Keep only jobs inside the trailing window (hours <= 0 means "everything"). */
export function filterWindow(jobs, hours, now = Date.now()) {
  if (!hours || hours <= 0) return jobs;
  const cutoff = now - hours * 3600 * 1000;
  return jobs.filter((job) => {
    const ts = Date.parse(job.finished ?? job.started ?? '');
    return Number.isFinite(ts) ? ts >= cutoff : false;
  });
}
