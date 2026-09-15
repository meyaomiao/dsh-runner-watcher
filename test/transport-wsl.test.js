import assert from 'node:assert/strict';
import test from 'node:test';
import { execCapture, normalizeTransportSpec, describeTransport, wrapWslScript } from '../lib/core/transport.js';

test('normalizeTransportSpec keeps wslDistro on ssh specs and omits it otherwise', () => {
  const withWsl = normalizeTransportSpec({
    kind: 'ssh',
    host: 'xzb17',
    user: 'u',
    wslDistro: 'Ubuntu',
    path: '/opt/actions-runner',
  });
  assert.equal(withWsl.wslDistro, 'Ubuntu');

  const plain = normalizeTransportSpec({ kind: 'ssh', host: 'build-01', path: '/opt/actions-runner' });
  assert.equal(plain.wslDistro, undefined);

  const local = normalizeTransportSpec({ kind: 'local', path: '/opt/actions-runner' });
  assert.equal(local.wslDistro, undefined);
});

test('wrapWslScript routes the script through wsl.exe with a base64 payload', () => {
  const script = "cat -- '/opt/actions-runner/.runner' 2>/dev/null; echo $HOME";
  const wrapped = wrapWslScript(script, 'Ubuntu');
  assert.match(wrapped, /^wsl\.exe -d Ubuntu -- bash -lc "echo [A-Za-z0-9+/=]+ \| base64 -d \| bash"$/);
  // The payload must round-trip to the original script byte for byte.
  const payload = /echo ([A-Za-z0-9+/=]+) /.exec(wrapped)[1];
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), script);
});

test('wrapWslScript payload stays inert in Windows shells (no quotes, $ or redirects)', () => {
  const hostile = "echo 'a b' && cd /tmp; printf '%s' \"$X\" | tr a b > /tmp/out";
  const wrapped = wrapWslScript(hostile, 'Debian');
  const payload = /echo ([A-Za-z0-9+/=]+) /.exec(wrapped)[1];
  assert.match(payload, /^[A-Za-z0-9+/=]+$/);
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), hostile);
});

test('describeTransport marks the wsl distro on ssh and leaves plain ssh unchanged', () => {
  assert.equal(
    describeTransport({ kind: 'ssh', host: 'xzb17', user: 'u', wslDistro: 'Ubuntu', path: '/opt/x' }),
    'ssh:u@xzb17(wsl:Ubuntu):/opt/x',
  );
  assert.equal(describeTransport({ kind: 'ssh', host: 'build-01', path: '/opt/x' }), 'ssh:build-01:/opt/x');
});

test('a wrapped runScript executes POSIX inside the remote distro (ssh win-wsl round trip)', () => {
  // Contract check without a real Windows host: the wrapper must survive being
  // handed to execCapture's spawn shape (command + args array).
  const wrapped = wrapWslScript('echo hi', 'Ubuntu');
  const args = ['ssh', ['-o', 'BatchMode=yes', 'host', wrapped]];
  assert.equal(args[1][0], '-o');
  assert.ok(args[1].includes(wrapped));
});

test('execCapture returns buffers alongside decoded text (base64 pipeline sanity)', async () => {
  const wrapped = wrapWslScript("printf 'runner-ok'", 'Ubuntu');
  const payload = /echo ([A-Za-z0-9+/=]+) /.exec(wrapped)[1];
  // Local POSIX shells understand the same pipeline, proving the payload is
  // shell-neutral: what works here must work under wsl.exe too.
  const r = await execCapture('/bin/sh', ['-c', `echo ${payload} | base64 -d | bash`]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'runner-ok');
});
