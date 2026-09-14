/**
 * Snapshot collection.
 *
 * One pass over the registry produces:
 *   - a live snapshot per runner (state, cgroup memory/CPU, processes, sizes)
 *   - the jobs found in that runner's `_diag` directory
 *
 * Everything goes through a transport, so the same code reads a local install,
 * a WSL install and a remote SSH install.
 * @module dsh-runner-scope/core/collect
 */

import path from 'node:path';
import { discoverOnTransport, readRunnerConfig } from './discover.js';
import { attachWorkers, parseListenerJobs, parseWorkerLog, RUNNER_NAME_RE, WORKER_NAME_RE } from './parse.js';
import { createTransportPool, describeTransport, normalizeTransportSpec } from './transport.js';
import { isoOrNull, pathInCommand } from './util.js';

export const DEFAULT_LIMITS = { runnerLogs: 40, workerLogs: 400 };

const SYSTEMD_FIELDS = [
  'Id',
  'Description',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'MemoryCurrent',
  'MemoryPeak',
  'CPUUsageNSec',
  'NRestarts',
  'ActiveEnterTimestamp',
  'Result',
];

/** `systemctl show` output -> plain object. */
export function parseSystemdShow(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

/**
 * systemd reports unset counters as `[not set]` or as an unsigned sentinel
 * near 2^64; both mean "no value", not "18 exabytes".
 */
export function parseCounter(value) {
  if (value == null) return 0;
  const text = String(value).trim();
  if (!text || text.startsWith('[')) return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 2 ** 62) return 0;
  return n;
}

/** Parse one `ps -eo pid,etime,pcpu,pmem,rss,vsz,args` line. */
export function parsePsLine(line) {
  const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (!m) return null;
  return {
    pid: Number(m[1]),
    etime: m[2],
    cpu_pct: Number(m[3]),
    mem_pct: Number(m[4]),
    rss_kb: Number(m[5]),
    vsz_kb: Number(m[6]),
    cmd: m[7],
  };
}

/** The last job started but not yet finished in a listener log. */
export function currentJobFromListener(text) {
  let lastStart = null;
  let lastEnd = null;
  for (const line of String(text ?? '').split('\n')) {
    const s = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})Z: Running job: (.+?)\s*$/.exec(line);
    if (s) lastStart = { started: isoOrNull(`${s[1]}Z`), name: s[2] };
    const e = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})Z: Job (.+) completed with result: \w+\s*$/.exec(line);
    if (e) lastEnd = { finished: isoOrNull(`${e[1]}Z`) };
  }
  if (lastStart && (!lastEnd || lastStart.started > lastEnd.finished)) return lastStart;
  return null;
}

async function listProcesses(transport) {
  const r = await transport.runScript('ps -eo pid,etime,pcpu,pmem,rss,vsz,args --no-headers 2>/dev/null');
  return r.stdout
    .split('\n')
    .map(parsePsLine)
    .filter(Boolean);
}

async function resolveUnit(transport, runner, agentName) {
  if (runner.unit) return runner.unit;
  if (!agentName) return null;
  const r = await transport.runScript(
    `ls -1 /etc/systemd/system/actions.runner.*.${agentName}.service 2>/dev/null | head -1`,
  );
  const found = r.stdout.trim();
  return found ? path.posix.basename(found) : null;
}

async function collectOne(transport, runner, { limits, now }) {
  const spec = normalizeTransportSpec(runner.transport);
  const installDir = spec.path;
  const identity = (await readRunnerConfig(transport, installDir)) ?? runner.identity ?? {};
  const workFolder = identity.workFolder ?? '_work';
  const joiner = transport.isLocal && process.platform === 'win32' ? path.win32.join : path.posix.join;
  const diagDir = joiner(installDir, '_diag');
  const workDir = joiner(installDir, workFolder);

  const [unit, processes, workBytes, diagEntries] = await Promise.all([
    resolveUnit(transport, runner, identity.agentName),
    listProcesses(transport),
    transport.dirSize(workDir),
    transport.readDir(diagDir),
  ]);

  let show = {};
  if (unit && !(transport.isLocal && process.platform === 'win32')) {
    const args = SYSTEMD_FIELDS.map((f) => `-p ${f}`).join(' ');
    const r = await transport.runScript(`systemctl show ${JSON.stringify(unit)} --no-pager ${args} 2>/dev/null`);
    show = parseSystemdShow(r.stdout);
  }

  const mine = processes.filter((p) => pathInCommand(installDir, p.cmd));
  const listenerProcs = mine.filter((p) => p.cmd.includes('Runner.Listener'));
  const workerProcs = mine.filter((p) => p.cmd.includes('Runner.Worker'));
  const processRss = mine.reduce((sum, p) => sum + p.rss_kb * 1024, 0);

  const runnerLogs = diagEntries.filter((f) => RUNNER_NAME_RE.test(f)).sort().slice(-limits.runnerLogs);
  const workerLogs = diagEntries.filter((f) => WORKER_NAME_RE.test(f)).sort().slice(-limits.workerLogs);

  let newestListenerText = '';
  const allListenerJobs = [];
  for (const file of runnerLogs) {
    const text = await transport.readText(path.posix.join(diagDir, file));
    if (text == null) continue;
    newestListenerText = text;
    allListenerJobs.push(...parseListenerJobs(text, { runner: runner.label, source: transport.describe() }));
  }

  const workerDetails = [];
  for (const file of workerLogs) {
    const text = await transport.readText(path.posix.join(diagDir, file));
    if (text == null) continue;
    workerDetails.push({ fileName: file, detail: parseWorkerLog(text, file) });
  }

  const jobs = attachWorkers(allListenerJobs, workerDetails, {
    runner: runner.label,
    source: transport.describe(),
  });

  const unitActive = show.ActiveState === 'active';
  let state = 'unknown';
  if (listenerProcs.length > 0 || unitActive) state = workerProcs.length > 0 ? 'busy' : 'idle';
  else if (show.ActiveState) state = show.ActiveState;

  const cpuNsec = parseCounter(show.CPUUsageNSec);
  return {
    runner: {
      id: runner.id,
      label: runner.label,
      transport: spec,
      source: describeTransport(spec),
      install_dir: installDir,
      work_dir: workDir,
      diag_dir: diagDir,
      identity,
      unit: unit ?? null,
      unit_state: show.ActiveState ?? null,
      unit_substate: show.SubState ?? null,
      unit_enabled: show.UnitFileState ?? null,
      main_pid: parseCounter(show.MainPID),
      n_restarts: parseCounter(show.NRestarts),
      result: show.Result ?? null,
      active_since: show.ActiveEnterTimestamp ?? null,
      memory_current_bytes: parseCounter(show.MemoryCurrent),
      memory_peak_bytes: parseCounter(show.MemoryPeak),
      cpu_usage_sec: cpuNsec ? Math.round((cpuNsec / 1e9) * 1000) / 1000 : 0,
      process_rss_bytes: processRss,
      work_bytes: workBytes,
      processes: mine,
      listener_running: listenerProcs.length > 0,
      worker_running: workerProcs.length > 0,
      state,
      current_job: workerProcs.length > 0 ? currentJobFromListener(newestListenerText) : null,
      error: null,
    },
    jobs,
  };
}

/**
 * Collect every enabled runner in the registry.
 *
 * A runner that fails (host offline, WSL stopped) yields an `error` snapshot
 * instead of aborting the pass, so one broken entry cannot hide the others.
 */
export async function collectRunners(registry, { limits = DEFAULT_LIMITS, now = new Date() } = {}) {
  const pool = createTransportPool();
  const snapshots = [];
  const allJobs = [];
  for (const runner of registry.runners ?? []) {
    if (runner.enabled === false) continue;
    let transport;
    try {
      transport = pool.get(runner.transport);
    } catch (error) {
      snapshots.push({ runner: { ...runner, state: 'error', error: String(error?.message ?? error) }, jobs: [] });
      continue;
    }
    try {
      const { runner: snapshot, jobs } = await collectOne(transport, runner, { limits, now });
      snapshots.push({ runner: snapshot, jobs });
      allJobs.push(...jobs);
    } catch (error) {
      snapshots.push({
        runner: {
          id: runner.id,
          label: runner.label,
          transport: normalizeTransportSpec(runner.transport),
          source: describeTransport(runner.transport),
          install_dir: runner.transport?.path ?? '',
          state: 'error',
          error: String(error?.message ?? error),
        },
        jobs: [],
      });
    }
  }
  return { snapshots, jobs: allJobs };
}

/** Host facts for the snapshot header (best-effort, never throws). */
export async function hostFacts(transport) {
  const script = [
    'echo "cpus=$(nproc 2>/dev/null || echo 0)"',
    'echo "host=$(hostname)"',
    'echo "load=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
    'awk \'/MemTotal|MemAvailable/ {printf "%s=%s\\n", $1, $2}\' /proc/meminfo 2>/dev/null',
    'df -B1 / 2>/dev/null | tail -1 | awk \'{printf "disk_size=%s disk_used=%s disk_avail=%s\\n", $2, $3, $4}\'',
  ].join('\n');
  const r = await transport.runScript(script);
  const fields = {};
  for (const line of r.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    hostname: fields.host || null,
    cpus: num(fields.cpus),
    loadavg: (fields.load || '').split(/\s+/).filter(Boolean).map(Number),
    memory: {
      total_kb: num(fields.MemTotal),
      available_kb: num(fields.MemAvailable),
    },
    disk_root: {
      size_bytes: num(fields.disk_size),
      used_bytes: num(fields.disk_used),
      avail_bytes: num(fields.disk_avail),
    },
  };
}

/** Probe a transport for a runner install at `dir` (used by `add --probe`). */
export async function probeInstall(transport, dir) {
  const identity = await readRunnerConfig(transport, dir);
  return identity ? { ok: true, identity, dir } : { ok: false, dir, reason: 'no readable .runner file' };
}

/** Convenience: discover candidates on a bare spec without a registry. */
export async function discoverSpec(spec, extraPaths = []) {
  const pool = createTransportPool();
  const transport = pool.get(spec);
  return discoverOnTransport(transport, { extraPaths });
}
