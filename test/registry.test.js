import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addRunner,
  associateCandidates,
  defaultRegistry,
  dropPending,
  findRunner,
  identityKey,
  loadRegistry,
  removeRunner,
  saveRegistry,
} from '../lib/core/registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const wslRunner = (agentName, agentId, dir = '/opt/actions-runner') => ({
  transport: { kind: 'wsl', distro: 'Ubuntu', path: dir },
  identity: { agentName, agentId, githubUrl: 'https://github.com/acme/repo', poolName: 'Default' },
});

test('identityKey prefers agentId, then repo+name, then path', () => {
  assert.equal(identityKey({ agentId: 27 }, { kind: 'local' }, '/x'), 'agent:27');
  assert.equal(
    identityKey({ agentName: 'a', githubUrl: 'https://github.com/o/r' }, { kind: 'local' }, '/x'),
    'gh:https://github.com/o/r#a',
  );
  assert.match(identityKey({}, { kind: 'local' }, '/x'), /^path:local:/);
});

test('addRunner registers once and updates on re-import', () => {
  const registry = defaultRegistry();
  const first = addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner'));
  assert.equal(first.created, true);
  assert.equal(registry.runners.length, 1);
  assert.equal(first.runner.label, 'wsl');

  // Same GitHub agent, new install directory -> update, never a duplicate.
  const second = addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner-moved'));
  assert.equal(second.created, false);
  assert.equal(registry.runners.length, 1);
  assert.equal(second.runner.transport.path, '/opt/actions-runner-moved');
});

test('findRunner resolves id, label, agent name, agent id and path', () => {
  const registry = defaultRegistry();
  const { runner } = addRunner(registry, wslRunner('worker-a', 27));
  assert.equal(findRunner(registry, runner.id), runner);
  assert.equal(findRunner(registry, 'worker-a'), runner);
  assert.equal(findRunner(registry, 'WORKER-A'), runner);
  assert.equal(findRunner(registry, '27'), runner);
  assert.equal(findRunner(registry, '/opt/actions-runner'), runner);
  assert.equal(findRunner(registry, 'nope'), null);
});

test('removeRunner drops only the matched entry', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('a', 1, '/opt/actions-runner'));
  addRunner(registry, wslRunner('b', 2, '/opt/actions-runner-2'));
  assert.equal(registry.runners.length, 2);
  const removed = removeRunner(registry, 'b');
  assert.equal(removed.identity.agentName, 'b');
  assert.equal(registry.runners.length, 1);
  assert.equal(removeRunner(registry, 'b'), null);
});

test('associateCandidates links the same agent found at a new path', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner'));
  const result = associateCandidates(registry, [
    { path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'path-scan' },
  ]);
  assert.equal(result.linked.length, 1);
  assert.equal(result.adopted.length, 0);
  assert.equal(registry.runners.length, 1);
  assert.equal(result.linked[0].moved, false);
  assert.equal(registry.runners[0].state, 'present');
});

test('associateCandidates detects a moved install directory', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner'));
  const result = associateCandidates(registry, [
    { path: '/srv/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'systemd' },
  ]);
  assert.equal(result.linked.length, 1);
  assert.equal(result.linked[0].moved, true);
  assert.equal(registry.runners[0].transport.path, '/srv/actions-runner');
});

test('associateCandidates parks unknown runners as pending by default', () => {
  const registry = defaultRegistry();
  const result = associateCandidates(registry, [
    { path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'systemd' },
  ]);
  assert.equal(result.pending.length, 1);
  assert.equal(result.adopted.length, 0);
  assert.equal(registry.runners.length, 0);
  assert.equal(registry.pending.length, 1);

  // A second pass updates the same pending row instead of duplicating it.
  associateCandidates(registry, [
    { path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'systemd' },
  ]);
  assert.equal(registry.pending.length, 1);
});

test('associateCandidates adopts when asked', () => {
  const registry = defaultRegistry();
  const result = associateCandidates(
    registry,
    [{ path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'systemd' }],
    { autoAdopt: true },
  );
  assert.equal(result.adopted.length, 1);
  assert.equal(registry.runners.length, 1);
  assert.equal(registry.runners[0].addedBy, 'adopted');
});

test('associateCandidates marks unseen runners missing but keeps them', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('gone', 99, '/opt/gone'));
  const result = associateCandidates(registry, []);
  assert.equal(result.missing.length, 1);
  assert.equal(registry.runners.length, 1);
  assert.equal(registry.runners[0].state, 'missing');
  assert.ok(registry.runners[0].missingSince);
});

test('associateCandidates does not call a runner missing when its host never answered', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('offline', 42, '/opt/offline'));
  registry.runners[0].state = 'present';
  const result = associateCandidates(registry, [], { unreachable: ['wsl:Ubuntu'] });
  assert.equal(result.missing.length, 0);
  assert.equal(result.unreachable.length, 1);
  // The last known state survives an unanswered sweep.
  assert.equal(registry.runners[0].state, 'present');
  assert.equal(registry.runners[0].missingSince, undefined);
});

test('associateCandidates clears missing once the runner is seen again', () => {
  const registry = defaultRegistry();
  addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner'));
  associateCandidates(registry, []);
  assert.equal(registry.runners[0].state, 'missing');
  const back = associateCandidates(registry, [
    { path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 } },
  ]);
  assert.equal(back.linked.length, 1);
  assert.equal(registry.runners[0].state, 'present');
  assert.equal(registry.runners[0].missingSince, undefined);
});

test('associateCandidates reports duplicate registrations of one agent', () => {
  const registry = defaultRegistry();
  registry.runners.push({
    id: 'dup-a',
    label: 'dup-a',
    transport: { kind: 'wsl', distro: 'Ubuntu', path: '/opt/a' },
    identity: { agentId: 27, agentName: 'wsl' },
  });
  registry.runners.push({
    id: 'dup-b',
    label: 'dup-b',
    transport: { kind: 'wsl', distro: 'Ubuntu', path: '/opt/b' },
    identity: { agentId: 27, agentName: 'wsl' },
  });
  const result = associateCandidates(registry, [
    { path: '/opt/a', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentId: 27, agentName: 'wsl' } },
  ]);
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].ids.sort(), ['dup-a', 'dup-b']);
});

test('dropPending removes one candidate', () => {
  const registry = defaultRegistry();
  registry.pending.push({ id: 'p1', label: 'a', path: '/a' }, { id: 'p2', label: 'b', path: '/b' });
  assert.equal(dropPending(registry, 'p1').id, 'p1');
  assert.equal(registry.pending.length, 1);
  assert.equal(dropPending(registry, 'missing'), null);
});

test('addRunner re-keys a path-registered entry once its identity is known', () => {
  const registry = defaultRegistry();
  // Registered before `.runner` was readable: keyed by transport+path.
  const first = addRunner(registry, { transport: { kind: 'wsl', distro: 'Ubuntu', path: '/opt/actions-runner' } });
  assert.equal(first.created, true);
  assert.deepEqual(first.runner.identity, {});

  // The same install, now with the identity read: must update, not duplicate.
  const second = addRunner(registry, wslRunner('wsl', 27, '/opt/actions-runner'));
  assert.equal(second.created, false);
  assert.equal(registry.runners.length, 1);
  assert.equal(second.runner.identity.agentId, 27);
});

test('associateCandidates links a path-keyed entry by host+path', () => {
  const registry = defaultRegistry();
  addRunner(registry, { transport: { kind: 'wsl', distro: 'Ubuntu', path: '/opt/actions-runner' } });
  const result = associateCandidates(registry, [
    { path: '/opt/actions-runner', transport: { kind: 'wsl', distro: 'Ubuntu' }, identity: { agentName: 'wsl', agentId: 27 }, via: 'systemd' },
  ]);
  assert.equal(result.linked.length, 1);
  assert.equal(result.adopted.length, 0);
  assert.equal(result.missing.length, 0, 'the linked runner must not also be reported missing');
  assert.equal(registry.runners.length, 1);
  assert.equal(registry.runners[0].identity.agentId, 27);
});

test('registry round-trips through disk and tolerates corruption', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-watcher-reg-'));
  try {
    const registry = defaultRegistry();
    addRunner(registry, wslRunner('wsl', 27));
    await saveRegistry(dir, registry);
    const loaded = await loadRegistry(dir);
    assert.equal(loaded.runners.length, 1);
    assert.equal(loaded.runners[0].identity.agentId, 27);

    // A truncated file must not crash the next run.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'runners.json'), '{ not json', 'utf8');
    const recovered = await loadRegistry(dir);
    assert.deepEqual(recovered.runners, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
