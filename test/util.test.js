import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clamp,
  gradeOf,
  isoOrNull,
  jobReliability,
  mean,
  normalizeDirKey,
  parseUtc,
  pathInCommand,
  percentile,
  secondsBetween,
  shortId,
  formatBytes,
  formatDuration,
} from '../lib/core/util.js';

test('clamp bounds and rejects non-numbers', () => {
  assert.equal(clamp(150), 100);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(42), 42);
  assert.equal(clamp(Number.NaN), 0);
  assert.equal(clamp(5, 1, 3), 3);
});

test('percentile interpolates like the reference implementation', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([7], 50), 7);
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

test('mean ignores non-finite values', () => {
  assert.equal(mean([]), null);
  assert.equal(mean([2, 4]), 3);
  assert.equal(mean([2, Number.NaN, 4]), 3);
});

test('jobReliability maps every runner outcome', () => {
  assert.equal(jobReliability('Succeeded'), 100);
  assert.equal(jobReliability('Success'), 100);
  assert.equal(jobReliability('Cancelled'), 35);
  assert.equal(jobReliability('Canceled'), 35);
  assert.equal(jobReliability('Skipped'), 35);
  assert.equal(jobReliability('Failed'), 0);
  assert.equal(jobReliability('Running'), null);
  assert.equal(jobReliability(null), null);
});

test('gradeOf maps score bands', () => {
  assert.equal(gradeOf(95), 'S');
  assert.equal(gradeOf(90), 'S');
  assert.equal(gradeOf(89.9), 'A');
  assert.equal(gradeOf(70), 'B');
  assert.equal(gradeOf(60), 'C');
  assert.equal(gradeOf(50), 'D');
  assert.equal(gradeOf(49.9), 'F');
  assert.equal(gradeOf(null), '-');
});

test('parseUtc accepts both runner and ISO stamps', () => {
  assert.equal(parseUtc('2026-09-13 02:13:31Z').toISOString(), '2026-09-13T02:13:31.000Z');
  assert.equal(parseUtc('2026-09-13T02:13:31Z').toISOString(), '2026-09-13T02:13:31.000Z');
  assert.equal(parseUtc(''), null);
  assert.equal(isoOrNull('2026-09-13 02:13:31Z'), '2026-09-13T02:13:31Z');
  assert.equal(secondsBetween('2026-09-13 02:13:31Z', '2026-09-13 02:18:31Z'), 300);
});

test('pathInCommand matches whole path segments only', () => {
  // The regression this guards: a plain substring test made
  // /opt/actions-runner match /opt/actions-runner-2 processes.
  assert.equal(pathInCommand('/opt/actions-runner', '/opt/actions-runner/bin/Runner.Listener run'), true);
  assert.equal(pathInCommand('/opt/actions-runner', '/opt/actions-runner-2/bin/Runner.Listener run'), false);
  assert.equal(pathInCommand('/opt/actions-runner-2', '/opt/actions-runner-2/bin/Runner.Listener run'), true);
  assert.equal(pathInCommand('/opt/actions-runner', '/bin/bash /opt/actions-runner/runsvc.sh'), true);
  assert.equal(pathInCommand('', 'anything'), false);
  assert.equal(pathInCommand('C:\\runner', 'C:/runner/bin/Runner.Listener.exe'), true);
});

test('normalizeDirKey is case- and separator-insensitive', () => {
  assert.equal(normalizeDirKey('C:\\Actions-Runner\\'), 'c:/actions-runner');
  assert.equal(normalizeDirKey('/opt/actions-runner/'), '/opt/actions-runner');
});

test('shortId is stable and prefixed', () => {
  const a = shortId('agent:27');
  assert.equal(a, shortId('agent:27'));
  assert.notEqual(a, shortId('agent:28'));
  assert.match(a, /^rn_[0-9a-f]{16}$/);
});

test('formatters are human readable', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatDuration(18.5), '18.5s');
  assert.equal(formatDuration(96), '1m36s');
  assert.equal(formatDuration(null), '-');
});
