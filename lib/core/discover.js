/**
 * Runner discovery.
 *
 * Discovery answers "what runner installs exist on this transport", without
 * caring whether the user already imported them. The registry decides what to
 * do with the candidates (link / adopt / park as pending) — see
 * `registry.associateCandidates`.
 *
 * Candidates are found three ways, in decreasing reliability:
 *
 *   systemd         — `actions.runner.*.service` units name their own
 *                     `WorkingDirectory`, which is authoritative
 *   windows-service — `actions.runner.*` services carry the install path in
 *                     their image path
 *   path-scan       — the conventional install locations
 *
 * @module dsh-runner-scope/core/discover
 */

import path from 'node:path';
import { execCapture, normalizeTransportSpec } from './transport.js';

/** Conventional install locations for POSIX hosts. */
export const POSIX_DIR_PATTERNS = [
  '/opt/actions-runner',
  '/opt/actions-runner*',
  '/usr/local/actions-runner',
  '/usr/local/actions-runner*',
  '$HOME/actions-runner',
  '$HOME/actions-runner*',
  '/home/*/actions-runner',
  '/home/*/actions-runner*',
];

/** Conventional install locations for Windows hosts. */
export function windowsDirPatterns(env = process.env) {
  const out = [];
  const drives = ['C:', 'D:'];
  for (const drive of drives) out.push(`${drive}\\actions-runner`, `${drive}\\actions-runner*`);
  if (env.USERPROFILE) {
    out.push(path.join(env.USERPROFILE, 'actions-runner'));
    out.push(path.join(env.USERPROFILE, 'actions-runner*'));
  }
  if (env.ProgramData) {
    out.push(path.join(env.ProgramData, 'actions-runner'));
    out.push(path.join(env.ProgramData, 'actions-runner*'));
  }
  if (env['ProgramFiles']) {
    out.push(path.join(env['ProgramFiles'], 'actions-runner'));
    out.push(path.join(env['ProgramFiles'], 'actions-runner*'));
  }
  return out;
}

/** Read and normalize a runner's `.runner` file into an identity. */
export async function readRunnerConfig(transport, dir) {
  const file = transport.isLocal
    ? path.join(dir, '.runner')
    : `${String(dir).replace(/\/+$/, '')}/.runner`;
  const raw = await transport.readJson(file);
  if (!raw || typeof raw !== 'object') return null;
  return {
    agentId: raw.agentId ?? null,
    agentName: raw.agentName ?? null,
    githubUrl: raw.gitHubUrl ?? null,
    poolName: raw.poolName ?? null,
    workFolder: raw.workFolder ?? '_work',
  };
}

/** Parse `WorkingDirectory=` out of a systemd unit file body. */
export function parseUnitWorkingDirectory(body) {
  const m = /^WorkingDirectory=(.+)$/m.exec(String(body ?? ''));
  return m ? m[1].trim() : null;
}

/** Parse the install dir out of a Windows service image path. */
export function parseWindowsServicePath(imagePath) {
  const text = String(imagePath ?? '').trim();
  if (!text) return null;
  const quoted = /^"([^"]+)"/.exec(text);
  const exe = quoted ? quoted[1] : text.split(/\s+/)[0];
  if (!exe) return null;
  const dir = path.win32.dirname(exe);
  // Services point at bin\Runner.Listener.exe (or RunnerService.exe); the
  // install root is one level up from `bin`.
  return path.win32.basename(dir).toLowerCase() === 'bin' ? path.win32.dirname(dir) : dir;
}

async function discoverSystemd(transport) {
  const out = [];
  if (transport.isLocal && process.platform === 'win32') return out;
  const listing = await transport.runScript(
    'ls -1 /etc/systemd/system/actions.runner.*.service 2>/dev/null',
  );
  const units = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const unit of units) {
    const body = await transport.readText(unit);
    const dir = parseUnitWorkingDirectory(body);
    if (dir) out.push({ path: dir, unit: path.posix.basename(unit), via: 'systemd' });
  }
  return out;
}

async function discoverWindowsServices() {
  if (process.platform !== 'win32') return [];
  const r = await execCapture(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Service -Filter \"Name LIKE 'actions.runner.%'\" | " +
        'Select-Object -Property Name,PathName | ConvertTo-Json -Compress -Depth 3',
    ],
    { timeoutMs: 20_000 },
  );
  if (!r.stdout.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const row of rows) {
    const dir = parseWindowsServicePath(row?.PathName);
    if (dir) out.push({ path: dir, unit: row?.Name ?? null, via: 'windows-service' });
  }
  return out;
}

/**
 * Discover every runner install reachable through one transport.
 *
 * @param transport - a transport from `createTransport`
 * @param options.extraPaths - explicit dirs to probe first (used by `add`)
 * @param options.includeSystemd - set false to skip unit discovery
 */
export async function discoverOnTransport(transport, { extraPaths = [], includeSystemd = true } = {}) {
  const spec = normalizeTransportSpec(transport.spec);
  const patterns =
    transport.isLocal && process.platform === 'win32'
      ? windowsDirPatterns()
      : POSIX_DIR_PATTERNS;

  const hits = new Map();
  const push = (dir, via, unit) => {
    if (!dir) return;
    const key = String(dir).replace(/\/+$/, '');
    if (!key) return;
    const prior = hits.get(key);
    if (prior && prior.via !== 'explicit') return;
    hits.set(key, { path: key, via, unit: unit ?? prior?.unit ?? null });
  };

  for (const dir of extraPaths) push(dir, 'explicit');

  const claimed = new Set([...hits.keys()]);
  if (includeSystemd) {
    for (const found of await discoverSystemd(transport)) {
      if (!claimed.has(found.path)) push(found.path, found.via, found.unit);
    }
  }
  if (transport.isLocal && process.platform === 'win32') {
    for (const found of await discoverWindowsServices()) {
      if (!claimed.has(found.path)) push(found.path, found.via, found.unit);
    }
  }

  const scanned = await transport.listDirs(patterns);
  for (const dir of scanned) push(dir, 'path-scan');

  const candidates = [];
  for (const hit of hits.values()) {
    const identity = await readRunnerConfig(transport, hit.path);
    if (!identity) continue; // not a runner install
    candidates.push({
      path: hit.path,
      unit: hit.unit,
      via: hit.via,
      transport: spec,
      identity,
    });
  }
  return candidates;
}

/**
 * Discover across several transports, tolerating individual failures.
 * @returns `{ candidates, errors }`
 */
export async function discoverAll(transports, options = {}) {
  const candidates = [];
  const errors = [];
  for (const transport of transports) {
    try {
      const found = await discoverOnTransport(transport, options);
      candidates.push(...found);
    } catch (error) {
      errors.push({ transport: transport.describe?.() ?? 'unknown', message: String(error?.message ?? error) });
    }
  }
  return { candidates, errors };
}
