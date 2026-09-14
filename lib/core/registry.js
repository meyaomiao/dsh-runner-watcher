/**
 * Runner registry + auto-association.
 *
 * The registry is the plugin's source of truth for "which runners am I
 * watching". Entries come from two places:
 *
 *   manual  — the user imported them (CLI `add`, tool `runner_watcher_add`)
 *   linked  — discovery found them and matched an existing entry
 *   adopted — discovery found them and imported them automatically
 *
 * Association is identity-first, not path-first. A runner is the same runner
 * when GitHub says it is the same agent (`agentId`), even if it moved to a new
 * install directory or was reinstalled; path is only the last-resort key.
 * @module dsh-runner-watcher/core/registry
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { describeTransport, normalizeTransportSpec } from './transport.js';
import { normalizeDirKey, shortId } from './util.js';

export const REGISTRY_VERSION = 1;

export function registryPath(dataDir) {
  return path.join(dataDir, 'runners.json');
}

export function defaultRegistry() {
  return { version: REGISTRY_VERSION, settings: {}, runners: [], pending: [] };
}

/**
 * The association key for a runner identity.
 *
 * `agentId` is GitHub-assigned and survives re-installs, so it wins whenever
 * discovery managed to read it. Falling back to `githubUrl + agentName` covers
 * hand-written entries; a transport+path key keeps a registry usable for a
 * runner whose `.runner` file could not be read at all.
 */
export function identityKey(identity, transport, dir) {
  const id = identity || {};
  if (id.agentId != null && id.agentId !== '') return `agent:${id.agentId}`;
  if (id.githubUrl && id.agentName) return `gh:${id.githubUrl}#${id.agentName}`;
  return `path:${describeTransport(transport)}|${normalizeDirKey(dir)}`;
}

export function entryKey(entry) {
  return identityKey(entry.identity, entry.transport, entry.transport?.path);
}

/** Transport identity without the path: one host, whichever directory is used. */
export function hostKey(transport) {
  return describeTransport({ ...normalizeTransportSpec(transport), path: '' });
}

/**
 * Find the registry entry a candidate belongs to.
 *
 * Identity is checked first, then the host+directory pair. The second test
 * matters because an entry can be *registered* before its `.runner` is
 * readable (path-keyed) and only later become identity-keyed; without the
 * fallback that transition would look like a brand-new runner and produce a
 * duplicate.
 */
export function matchRegistered(runners, identity, transport, dir) {
  const key = identityKey(identity, transport, dir);
  const byIdentity = (runners ?? []).find((r) => entryKey(r) === key);
  if (byIdentity) return byIdentity;
  const dirKey = normalizeDirKey(dir);
  if (!dirKey) return null;
  const host = hostKey(transport);
  return (
    (runners ?? []).find(
      (r) => hostKey(r.transport) === host && normalizeDirKey(r.transport?.path) === dirKey,
    ) ?? null
  );
}

export async function loadRegistry(dataDir) {
  const file = registryPath(dataDir);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return defaultRegistry();
  }
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return {
      version: parsed.version ?? REGISTRY_VERSION,
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      runners: Array.isArray(parsed.runners) ? parsed.runners : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return defaultRegistry();
  }
}

export async function saveRegistry(dataDir, registry) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = registryPath(dataDir);
  const tmp = `${file}.tmp`;
  const body = JSON.stringify(registry, null, 2);
  await fs.writeFile(tmp, `${body}\n`, 'utf8');
  await fs.rename(tmp, file);
  return file;
}

/** Resolve a user-supplied selector: registry id, label, agent name, or path. */
export function findRunner(registry, selector) {
  const needle = String(selector ?? '').trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  const runners = registry.runners ?? [];
  return (
    runners.find((r) => r.id === needle) ??
    runners.find((r) => (r.label ?? '').toLowerCase() === lower) ??
    runners.find((r) => String(r.identity?.agentName ?? '').toLowerCase() === lower) ??
    runners.find((r) => String(r.identity?.agentId ?? '') === needle) ??
    runners.find((r) => normalizeDirKey(r.transport?.path) === normalizeDirKey(needle)) ??
    null
  );
}

/**
 * Import one runner.
 * @param registry - mutated in place
 * @param spec - `{ label?, transport, identity?, tags?, addedBy? }`
 */
export function addRunner(registry, spec) {
  if (!spec?.transport) throw new TypeError('addRunner requires a transport');
  const transport = normalizeTransportSpec(spec.transport);
  const existing = matchRegistered(registry.runners, spec.identity, transport, transport.path);
  if (existing) {
    // Re-importing the same agent is an update, not a duplicate.
    existing.transport = transport;
    existing.identity = { ...(existing.identity ?? {}), ...(spec.identity ?? {}) };
    existing.lastSeenAt = new Date().toISOString();
    existing.enabled = existing.enabled !== false;
    delete existing.missingSince;
    existing.state = 'present';
    return { runner: existing, created: false };
  }
  const key = identityKey(spec.identity, transport, transport.path);
  const label =
    spec.label ??
    spec.identity?.agentName ??
    (transport.path ? path.posix.basename(transport.path.replace(/\\/g, '/')) : describeTransport(transport));
  const runner = {
    id: shortId(key),
    label: String(label),
    transport,
    identity: spec.identity ? { ...spec.identity } : {},
    enabled: spec.enabled !== false,
    addedBy: spec.addedBy ?? 'manual',
    addedAt: new Date().toISOString(),
    lastSeenAt: null,
    tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
  };
  registry.runners = [...(registry.runners ?? []), runner];
  return { runner, created: true };
}

/** Remove one runner by selector. Returns the removed entry, or null. */
export function removeRunner(registry, selector) {
  const runner = findRunner(registry, selector);
  if (!runner) return null;
  registry.runners = (registry.runners ?? []).filter((r) => r !== runner);
  registry.pending = (registry.pending ?? []).filter((p) => p.id !== runner.id);
  return runner;
}

/**
 * Link discovered candidates to the registry.
 *
 * This is the "auto-associate" step. Every candidate is matched against the
 * registry by identity; a match *updates* the existing entry (its install dir
 * may have changed since it was imported) instead of creating a second entry
 * for the same GitHub agent. Unmatched candidates are adopted or parked in
 * `pending`, depending on `autoAdopt`.
 *
 * @param options.unreachable - transport descriptions that failed to answer. A
 *   runner on an unreachable host is NOT marked missing: not finding it proves
 *   nothing when the host never replied.
 * @returns `{ linked, adopted, pending, missing, unreachable, conflicts }`
 */
export function associateCandidates(
  registry,
  candidates,
  { autoAdopt = false, now = new Date(), unreachable = [] } = {},
) {
  const stamp = now.toISOString();
  const linked = [];
  const adopted = [];
  const pending = [];
  const unreachableRunners = [];
  // Track matches by entry *object*: a runner registered before its `.runner`
  // was readable is path-keyed, and comparing identity keys alone would then
  // report it missing in the very pass that linked it.
  const matched = new Set();
  const downHosts = new Set((unreachable ?? []).map((entry) => String(entry)));

  for (const candidate of candidates ?? []) {
    const transport = normalizeTransportSpec(candidate.transport);
    const key = identityKey(candidate.identity, transport, candidate.path);
    const identity = candidate.identity ? { ...candidate.identity } : {};
    const existing = matchRegistered(registry.runners, identity, transport, candidate.path);

    if (existing) {
      matched.add(existing);
      const moved = normalizeDirKey(existing.transport?.path) !== normalizeDirKey(candidate.path);
      existing.transport = { ...transport, path: candidate.path };
      existing.identity = { ...(existing.identity ?? {}), ...identity };
      existing.lastSeenAt = stamp;
      existing.state = 'present';
      delete existing.missingSince;
      if (candidate.unit) existing.unit = candidate.unit;
      if (moved) existing.movedFrom = existing.movedFrom ?? null;
      linked.push({ runner: existing, moved, via: candidate.via });
      continue;
    }

    if (autoAdopt) {
      const { runner } = addRunner(registry, {
        transport: { ...transport, path: candidate.path },
        identity,
        addedBy: 'adopted',
      });
      runner.lastSeenAt = stamp;
      runner.state = 'present';
      if (candidate.unit) runner.unit = candidate.unit;
      matched.add(runner);
      adopted.push(runner);
      continue;
    }

    const entry = {
      id: shortId(key),
      path: candidate.path,
      transport: { ...transport, path: candidate.path },
      identity,
      via: candidate.via ?? 'scan',
      foundAt: stamp,
      label: identity.agentName ?? path.posix.basename(String(candidate.path).replace(/\\/g, '/')),
    };
    const prior = (registry.pending ?? []).find((p) => p.id === entry.id);
    if (prior) {
      Object.assign(prior, entry);
      pending.push(prior);
    } else {
      registry.pending = [...(registry.pending ?? []), entry];
      pending.push(entry);
    }
  }

  // Anything registered but not seen this pass is kept, just marked missing —
  // a runner that is temporarily offline must not silently vanish. A host that
  // never answered is a different story: absence of evidence is not evidence.
  const missing = [];
  for (const runner of registry.runners ?? []) {
    if (matched.has(runner)) continue;
    if (downHosts.has(hostKey(runner.transport))) {
      runner.state = runner.state ?? 'unknown';
      unreachableRunners.push(runner);
      continue;
    }
    runner.state = 'missing';
    runner.missingSince = runner.missingSince ?? stamp;
    missing.push(runner);
  }

  // Two entries resolving to one GitHub agent is a configuration mistake worth
  // reporting rather than silently collapsing.
  const conflicts = [];
  const buckets = new Map();
  for (const runner of registry.runners ?? []) {
    const k = entryKey(runner);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(runner);
  }
  for (const [k, group] of buckets) {
    if (group.length > 1) conflicts.push({ key: k, ids: group.map((r) => r.id) });
  }

  return { linked, adopted, pending, missing, unreachable: unreachableRunners, conflicts };
}

/** Drop a pending candidate by id/label/path. */
export function dropPending(registry, selector) {
  const needle = String(selector ?? '').trim().toLowerCase();
  const before = registry.pending ?? [];
  const hit = before.find(
    (p) =>
      p.id === selector ||
      String(p.label ?? '').toLowerCase() === needle ||
      normalizeDirKey(p.path) === normalizeDirKey(selector),
  );
  registry.pending = before.filter((p) => p !== hit);
  return hit ?? null;
}
