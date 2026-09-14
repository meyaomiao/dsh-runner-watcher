/**
 * Small dependency-free helpers shared by the collector, the scorer and the
 * report renderer. Everything here is pure so the unit tests can call it
 * directly.
 * @module dsh-runner-watcher/core/util
 */

/** Clamp `x` into `[lo, hi]`. */
export function clamp(x, lo = 0, hi = 100) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/** Arithmetic mean, or `null` for an empty list. */
export function mean(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile (`p` in 0..100), or `null` for an empty list. */
export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const k = ((xs.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return xs[f];
  return xs[f] * (c - k) + xs[c] * (k - f);
}

/**
 * Reliability leg of the score model.
 * Success is 100, a skipped/cancelled job is 35, a real failure is 0, and an
 * unfinished job has no reliability at all.
 */
export function jobReliability(result) {
  if (result === 'Succeeded' || result === 'Success') return 100;
  if (result === 'Cancelled' || result === 'Canceled' || result === 'Skipped') return 35;
  if (result == null || result === 'Running' || result === 'Unknown') return null;
  return 0;
}

const GRADES = [
  [90, 'S'],
  [80, 'A'],
  [70, 'B'],
  [60, 'C'],
  [50, 'D'],
];

/** Letter grade for a 0..100 score (`-` when unknown). */
export function gradeOf(score) {
  if (score == null || !Number.isFinite(Number(score))) return '-';
  const s = Number(score);
  for (const [floor, letter] of GRADES) {
    if (s >= floor) return letter;
  }
  return 'F';
}

/** True for the two success spellings the runner emits. */
export function isSuccess(result) {
  return result === 'Succeeded' || result === 'Success';
}

/** Parse the runner's `YYYY-MM-DD HH:MM:SSZ` stamp (also accepts ISO `T`). */
export function parseUtc(ts) {
  if (!ts) return null;
  const text = String(ts).trim().replace('Z', '').replace('T', ' ');
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!m) {
    const fallback = new Date(ts);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/** `Date` -> `YYYY-MM-DDTHH:MM:SSZ`. */
export function toIso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** Normalize any accepted stamp to the canonical ISO form. */
export function isoOrNull(ts) {
  if (!ts) return null;
  const d = parseUtc(ts);
  return d ? toIso(d) : String(ts).replace(' ', 'T');
}

/** Seconds between two runner stamps. */
export function secondsBetween(a, b) {
  const da = parseUtc(a);
  const db = parseUtc(b);
  if (!da || !db) return null;
  return Math.max(0, (db.getTime() - da.getTime()) / 1000);
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-';
  const s = Number(sec);
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** Collapse a runner install dir to a stable comparison key. */
export function normalizeDirKey(dir) {
  return String(dir || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * True when `cmd` references `dir` as a whole path segment.
 *
 * A plain substring test is wrong here: `/opt/actions-runner` is a prefix of
 * `/opt/actions-runner-2`, so two runners installed side by side would both
 * match each other's processes and cgroup accounting.
 */
export function pathInCommand(dir, cmd) {
  const needle = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!needle) return false;
  const hay = String(cmd || '').replace(/\\/g, '/');
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) return false;
    const next = hay[idx + needle.length] ?? '';
    if (next === '' || next === '/' || next === ' ' || next === '\t') return true;
    from = idx + 1;
  }
}

/** Stable short id for a registry entry. */
export function shortId(seed) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0;
  }
  return `rn_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Drop `undefined` values so JSON stays free of absent keys. */
export function compactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}
