/**
 * Session orchestration.
 *
 * The plugin tools, the CLI and the tests all drive the same object: a session
 * bound to one data directory. Keeping the sequence here (discover -> collect
 * -> store -> analyze -> render) means the agent-facing tools and the
 * command-line path can never drift apart.
 * @module dsh-runner-scope/core/session
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { analyze } from './analyze.js';
import { collectRunners, hostFacts } from './collect.js';
import { discoverOnTransport, readRunnerConfig } from './discover.js';
import {
  addRunner as addRunnerEntry,
  associateCandidates,
  dropPending,
  findRunner,
  loadRegistry,
  removeRunner as removeRunnerEntry,
  saveRegistry,
} from './registry.js';
import { writeDashboard } from './report.js';
import { appendJsonl, filterWindow, loadJobs, snapshotsPath, upsertJobs } from './store.js';
import { createTransport, createTransportPool, describeTransport, listWslDistros, normalizeTransportSpec } from './transport.js';
import { toIso } from './util.js';

export const DEFAULT_SETTINGS = {
  windowHours: 168,
  rollingWindow: 6,
  autoDiscover: true,
  autoAdopt: false,
  refreshSeconds: 0,
};

/** Parse a `kind:target` shorthand or a JSON object into a transport spec. */
export function parseTransportSpec(input) {
  if (!input) return null;
  if (typeof input === 'object') return normalizeTransportSpec(input);
  const text = String(input).trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return normalizeTransportSpec(JSON.parse(text));
    } catch {
      throw new TypeError(`invalid transport JSON: ${text}`);
    }
  }
  const [kind, ...rest] = text.split(':');
  const target = rest.join(':');
  const lower = kind.toLowerCase();
  if (lower === 'local') return normalizeTransportSpec({ kind: 'local', path: target || undefined });
  if (lower === 'wsl') {
    const [distro, ...tail] = target.split(':');
    return normalizeTransportSpec({ kind: 'wsl', distro, path: tail.join(':') });
  }
  if (lower === 'ssh') {
    const [hostPart, ...tail] = target.split(':');
    const at = hostPart.indexOf('@');
    return normalizeTransportSpec({
      kind: 'ssh',
      host: at >= 0 ? hostPart.slice(at + 1) : hostPart,
      user: at >= 0 ? hostPart.slice(0, at) : undefined,
      path: tail.join(':'),
    });
  }
  // Bare path -> a local transport.
  return normalizeTransportSpec({ kind: 'local', path: text });
}

/**
 * The transports a discovery pass should sweep when the caller named none:
 * this machine, every WSL distribution, and anything already in the registry.
 */
export async function defaultTransports(registry) {
  const specs = [{ kind: 'local' }];
  for (const distro of await listWslDistros()) specs.push({ kind: 'wsl', distro });
  for (const runner of registry.runners ?? []) {
    if (runner.transport) specs.push(runner.transport);
  }
  const seen = new Set();
  return specs
    .map(normalizeTransportSpec)
    .filter((spec) => {
      // Compare without the path so one entry per host is enough for scanning.
      const key = describeTransport({ ...spec, path: '' });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Pick the transport whose host facts best describe where the runners live. */
function primaryHostTransport(transports) {
  return transports.find((t) => t.kind === 'wsl') ?? transports[0] ?? createTransport({ kind: 'local' });
}

export async function openSession({ dataDir, settings = {} } = {}) {
  if (!dataDir) throw new TypeError('openSession requires a dataDir');
  await fs.mkdir(dataDir, { recursive: true });
  // An explicitly-undefined key must not shadow a default: a CLI that passes
  // `{ windowHours: undefined }` means "use the default", not "no window".
  const merged = { ...DEFAULT_SETTINGS };
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined) merged[key] = value;
  }
  const session = {
    dataDir,
    settings: merged,
    registry: await loadRegistry(dataDir),
    pool: createTransportPool(),
  };

  session.reload = async () => {
    session.registry = await loadRegistry(dataDir);
    return session.registry;
  };
  session.save = async () => saveRegistry(dataDir, session.registry);

  session.listRunners = () => session.registry.runners ?? [];

  session.addRunner = async (spec) => {
    const transport = normalizeTransportSpec(
      spec.transport ?? parseTransportSpec(spec.path ?? spec.transportSpec),
    );
    // Read `.runner` before registering so the entry is keyed by the GitHub
    // agent from the start, and so the label defaults to the agent name.
    let identity = spec.identity ?? null;
    if (!identity) {
      try {
        identity = await readRunnerConfig(session.pool.get(transport), transport.path);
      } catch {
        // A runner that cannot be read right now is still worth registering;
        // it lands path-keyed and is re-keyed by the next discovery pass.
        identity = null;
      }
    }
    const { runner, created } = addRunnerEntry(session.registry, {
      label: spec.label,
      transport,
      identity,
      tags: spec.tags,
      addedBy: spec.addedBy ?? 'manual',
    });
    await session.save();
    return { runner, created, probed: identity != null };
  };

  session.removeRunner = async (selector) => {
    const removed = removeRunnerEntry(session.registry, selector);
    if (removed) await session.save();
    return removed;
  };

  session.discover = async ({ transports, adopt = null, extraPaths = [] } = {}) => {
    const specs = (transports?.length ? transports : await defaultTransports(session.registry))
      .map(parseTransportSpec)
      .filter(Boolean);
    const candidates = [];
    const errors = [];
    const unreachable = [];
    for (const spec of specs) {
      try {
        const transport = session.pool.get(spec);
        candidates.push(...(await discoverOnTransport(transport, { extraPaths })));
      } catch (error) {
        const where = describeTransport(spec);
        errors.push({ transport: where, message: String(error?.message ?? error) });
        unreachable.push(describeTransport({ ...normalizeTransportSpec(spec), path: '' }));
      }
    }
    const shouldAdopt = adopt ?? session.settings.autoAdopt === true;
    const association = associateCandidates(session.registry, candidates, {
      autoAdopt: shouldAdopt,
      unreachable,
    });
    await session.save();
    return { candidates, errors, association, adopted: shouldAdopt };
  };

  session.adoptPending = async (selectors = []) => {
    const pending = session.registry.pending ?? [];
    const chosen = selectors.length
      ? pending.filter((p) =>
          selectors.some(
            (sel) =>
              p.id === sel ||
              String(p.label ?? '').toLowerCase() === String(sel).toLowerCase() ||
              String(p.path ?? '') === String(sel),
          ),
        )
      : pending;
    const adopted = [];
    for (const entry of chosen) {
      const { runner } = addRunnerEntry(session.registry, {
        label: entry.label,
        transport: entry.transport,
        identity: entry.identity,
        addedBy: 'adopted',
      });
      runner.state = 'present';
      runner.lastSeenAt = new Date().toISOString();
      adopted.push(runner);
      dropPending(session.registry, entry.id);
    }
    await session.save();
    return adopted;
  };

  session.liveStatus = async ({ transports } = {}) => {
    const specs = (transports?.length ? transports : await defaultTransports(session.registry))
      .map(parseTransportSpec)
      .filter(Boolean);
    const hostTransport = primaryHostTransport(specs.map((spec) => session.pool.get(spec)));
    let host = null;
    try {
      host = await hostFacts(hostTransport);
    } catch {
      host = null;
    }
    const { snapshots } = await collectRunners(session.registry, { now: new Date() });
    return {
      ts: toIso(new Date()),
      host,
      runners: snapshots.map((s) => s.runner),
      registry: { runners: session.listRunners(), pending: session.registry.pending ?? [] },
    };
  };

  session.collect = async ({ hours, autoDiscover = null, transports, writeDashboardFile = false } = {}) => {
    const windowHours = hours ?? session.settings.windowHours;
    const discovery = autoDiscover ?? session.settings.autoDiscover
      ? await session.discover({ transports }).catch(() => null)
      : null;
    const { snapshots, jobs } = await collectRunners(session.registry, { now: new Date() });
    const stored = await upsertJobs(dataDir, jobs);

    const specs = await defaultTransports(session.registry);
    let host = null;
    try {
      host = await hostFacts(primaryHostTransport(specs.map((spec) => session.pool.get(spec))));
    } catch {
      host = null;
    }
    const snapshot = {
      ts: toIso(new Date()),
      host,
      runners: snapshots.map((s) => s.runner),
      jobCount: stored.length,
      collected: jobs.length,
    };
    await appendJsonl(snapshotsPath(dataDir), snapshot);
    await fs.writeFile(path.join(dataDir, 'last_state.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

    const stats = analyze(filterWindow(stored, windowHours), {
      windowHours,
      rollingWindow: session.settings.rollingWindow,
    });
    const result = { snapshot, stats, jobs: filterWindow(stored, windowHours), stored, discovery };
    if (writeDashboardFile) {
      result.dashboard = await writeDashboard({
        snapshot,
        stats,
        jobs: result.jobs,
        registry: session.registry,
        hours: windowHours,
        rollingWindow: session.settings.rollingWindow,
        refreshSeconds: session.settings.refreshSeconds ?? 0,
        dataDir,
      });
    }
    return result;
  };

  session.analyze = async ({ hours } = {}) => {
    const windowHours = hours ?? session.settings.windowHours;
    const jobs = filterWindow(await loadJobs(dataDir), windowHours);
    return analyze(jobs, { windowHours, rollingWindow: session.settings.rollingWindow });
  };

  session.jobs = async ({ hours } = {}) => {
    const windowHours = hours ?? session.settings.windowHours;
    return filterWindow(await loadJobs(dataDir), windowHours);
  };

  session.dashboard = async ({ hours, outFile, refreshSeconds } = {}) => {
    const windowHours = hours ?? session.settings.windowHours;
    const jobs = filterWindow(await loadJobs(dataDir), windowHours);
    const stats = analyze(jobs, { windowHours, rollingWindow: session.settings.rollingWindow });
    const lastState = path.join(dataDir, 'last_state.json');
    let snapshot;
    try {
      snapshot = JSON.parse(await fs.readFile(lastState, 'utf8'));
    } catch {
      snapshot = { ts: toIso(new Date()), host: null, runners: [], jobCount: jobs.length };
    }
    return writeDashboard(
      {
        snapshot,
        stats,
        jobs,
        registry: session.registry,
        hours: windowHours,
        rollingWindow: session.settings.rollingWindow,
        refreshSeconds: refreshSeconds ?? session.settings.refreshSeconds ?? 0,
        dataDir,
      },
      { outFile },
    );
  };

  session.findRunner = (selector) => findRunner(session.registry, selector);

  return session;
}
