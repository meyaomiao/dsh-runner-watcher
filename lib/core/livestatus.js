/**
 * Near-real-time runner status: one batched round trip per transport.
 *
 * Full collection parses every _diag log file (minutes over WSL). Live status
 * only answers "is each runner up, how much memory, what is it running now",
 * and everything one host has to say fits into a single shell script — the
 * round trips cost, not the work. The script emits one `\u001f`-separated
 * record per install directory; parsing happens in Node.
 * @module dsh-runner-watcher/core/livestatus
 */

import { normalizeTransportSpec, describeTransport } from './transport.js';
import { normalizeDirKey } from './util.js';

/** POSIX-quote a path for embedding in the batched script. */
function shq(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build one POSIX script that reports every install directory on the host.
 * @param {string[]} dirs - runner install directories (the `.runner` level)
 */
export function buildLiveStatusScript(dirs) {
  const list = (dirs ?? []).map((d) => shq(d)).join(' ');
  return [
    'set +e',
    `for d in ${list}; do`,
    `  u=$(grep -l "^WorkingDirectory=$d$" /etc/systemd/system/actions.runner.*.service 2>/dev/null | head -1 | xargs -r basename)`,
    `  st=$(systemctl show "$u" -p ActiveState -p SubState -p NRestarts -p MemoryCurrent -p MemoryPeak -p CPUUsageNSec 2>/dev/null | tr '\\n' '|')`,
    '  lst=0; wrk=0',
    `  ps -eo args 2>/dev/null | grep -F -- "$d/bin/Runner.Listener" | grep -v grep >/dev/null && lst=1`,
    `  ps -eo args 2>/dev/null | grep -F -- "$d/bin/Runner.Worker" | grep -v grep >/dev/null && wrk=1`,
    `  job=''`,
    `  f=$(ls -1t "$d"/_diag/Worker_*.log 2>/dev/null | head -1)`,
    `  if [ -n "$f" ]; then job=$(grep -ao 'jobDisplayName": *"[^"]*"' "$f" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//'); fi`,
    `  printf 'RW1\\037%s\\037%s\\037%s\\037%s\\037%s\\037%s\\n' "$d" "$u" "$st" "$lst" "$wrk" "$job"`,
    'done',
  ].join('\n');
}

const UNIT_FIELDS = {
  ActiveState: 'active',
  SubState: 'sub',
  NRestarts: 'restarts',
  MemoryCurrent: 'memCurrent',
  MemoryPeak: 'memPeak',
  CPUUsageNSec: 'cpuNSec',
};
const UNIT_TEXT = new Set(['active', 'sub']);

/**
 * Parse the batched script output into rows.
 * @returns {Array<{path,unit,active,sub,restarts,memCurrent,memPeak,cpuSec,listener,worker,job}>}
 */
export function parseLiveStatusOutput(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('RW1\u001f')) continue;
    const parts = line.slice(4).split('\u001f');
    if (parts.length < 6) continue;
    const [dir, unit, st, lst, wrk, job] = parts;
    const unitProps = {};
    String(st ?? '')
      .split('|')
      .filter(Boolean)
      .forEach((kv) => {
        const eq = kv.indexOf('=');
        if (eq < 0) return;
        const field = UNIT_FIELDS[kv.slice(0, eq)];
        if (!field) return;
        const value = kv.slice(eq + 1);
        if (UNIT_TEXT.has(field)) unitProps[field] = value;
        else {
          const n = Number(value);
          unitProps[field] = Number.isFinite(n) ? n : null;
        }
      });
    rows.push({
      path: dir || null,
      unit: unit ? unit : null,
      active: unitProps.active ?? null,
      sub: unitProps.sub ?? null,
      restarts: unitProps.restarts ?? null,
      memCurrent: unitProps.memCurrent ?? null,
      memPeak: unitProps.memPeak ?? null,
      cpuSec: unitProps.cpuNSec != null ? unitProps.cpuNSec / 1e9 : null,
      listener: lst === '1',
      worker: wrk === '1',
      job: job || null,
    });
  }
  return rows;
}

/** State word for the dashboard pill, derived from live evidence alone. */
export function liveStateOf(row) {
  if (!row || row.active == null) return 'unknown';
  if (row.active !== 'active') return 'offline';
  return row.worker ? 'busy' : 'idle';
}

/**
 * One round trip per transport for every registered runner.
 * @returns `{ ts, runners, errors }` — runners not answering keep nothing here;
 * the caller merges over its cache, so a failed host simply leaves stale rows.
 */
export async function collectLiveStatus(session, { now = new Date() } = {}) {
  const runners = (session.listRunners() ?? []).filter((r) => r.enabled !== false && r.transport);
  const groups = new Map();
  for (const r of runners) {
    const spec = normalizeTransportSpec(r.transport);
    const key = describeTransport({ ...spec, path: '' });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ runner: r, spec });
  }
  const out = [];
  const errors = [];
  for (const group of groups.values()) {
    const transport = session.pool.get(group[0].spec);
    try {
      const script = buildLiveStatusScript(group.map((g) => g.spec.path).filter(Boolean));
      const r = await transport.runScript(script);
      for (const row of parseLiveStatusOutput(r.stdout)) {
        const hit = group.find((g) => normalizeDirKey(g.spec.path) === normalizeDirKey(row.path));
        if (!hit) continue;
        out.push({
          id: hit.runner.id,
          label: hit.runner.label,
          ...row,
          state: liveStateOf(row),
        });
      }
    } catch (error) {
      errors.push({ transport: describeTransport(group[0].spec), message: String(error?.message ?? error) });
    }
  }
  return { ts: now.toISOString(), runners: out, errors };
}
